//! Native counterpart of the page's `src/shared/model-setup.ts`. This cannot call stock: the research contract,
//! picked-model restriction and role grouping belong to OMPdesk. `setup-captured.json` pins both implementations.

use std::collections::HashMap;

use icu_properties::CodePointMapData;
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::fs::order::{is_js_space, js_trim};
use crate::server::Fault;

pub const TIMEOUT_MS: u64 = 10 * 60_000;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub research_model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub models: Vec<Model>,
    pub roles: Vec<Role>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub selector: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<Cost>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intelligence: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Cost {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Role {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
}

fn invalid(message: impl Into<String>) -> Fault {
    Fault::new(
        "model_setup_invalid",
        format!("Invalid model setup request: {}", message.into()),
    )
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn required<'a>(value: Option<&'a Value>, expected: &str) -> Result<&'a Value, Fault> {
    match value {
        None => Err(invalid("Required")),
        Some(value) if kind(value) == expected => Ok(value),
        Some(value) => Err(invalid(format!(
            "Expected {expected}, received {}",
            kind(value)
        ))),
    }
}

fn object(value: Option<&Value>) -> Result<&Map<String, Value>, Fault> {
    required(value, "object")?
        .as_object()
        .ok_or_else(|| invalid("Expected object"))
}

fn text(value: Option<&Value>, min: usize, max: usize) -> Result<&str, Fault> {
    let value = required(value, "string")?
        .as_str()
        .ok_or_else(|| invalid("Expected string"))?;
    let units = value.encode_utf16().count();
    if units < min {
        return Err(invalid(format!(
            "String must contain at least {min} character(s)"
        )));
    }
    if units > max {
        return Err(invalid(format!(
            "String must contain at most {max} character(s)"
        )));
    }
    Ok(value)
}

pub fn is_selector(value: &str) -> bool {
    if value.encode_utf16().count() > 200 {
        return false;
    }
    let Some((provider, model)) = value.split_once('/') else {
        return false;
    };
    !provider.is_empty()
        && !provider.starts_with('-')
        && !model.is_empty()
        && !value.chars().any(is_js_space)
}

fn selector(value: Option<&Value>) -> Result<(), Fault> {
    let value = text(value, 0, 200)?;
    if is_selector(value) {
        Ok(())
    } else {
        Err(invalid("Invalid model selector"))
    }
}

fn optional_number(object: &Map<String, Value>, key: &str, nonnegative: bool) -> Result<(), Fault> {
    if let Some(value) = object.get(key) {
        let number = required(Some(value), "number")?
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or_else(|| invalid("Number must be finite"))?;
        if nonnegative && number < 0.0 {
            return Err(invalid("Number must be greater than or equal to 0"));
        }
    }
    Ok(())
}

fn array(value: Option<&Value>, max: usize) -> Result<&[Value], Fault> {
    let values = required(value, "array")?
        .as_array()
        .ok_or_else(|| invalid("Expected array"))?;
    if values.is_empty() {
        return Err(invalid("Array must contain at least 1 element(s)"));
    }
    if values.len() > max {
        return Err(invalid(format!(
            "Array must contain at most {max} element(s)"
        )));
    }
    Ok(values)
}

impl Request {
    /// Validate the untrusted page payload before any child is started, in the schema's field order.
    pub fn parse(value: &Value) -> Result<Self, Fault> {
        let input = object(Some(value))?;
        selector(input.get("researchModel"))?;
        if let Some(value) = input.get("defaultModel") {
            selector(Some(value))?;
        }
        for model in array(input.get("models"), 500)? {
            let model = object(Some(model))?;
            selector(model.get("selector"))?;
            text(model.get("provider"), 1, 100)?;
            if let Some(name) = model.get("name") {
                text(Some(name), 0, 200)?;
            }
            optional_number(model, "contextWindow", true)?;
            if let Some(cost) = model.get("cost") {
                let cost = object(Some(cost))?;
                optional_number(cost, "input", true)?;
                optional_number(cost, "output", true)?;
            }
            optional_number(model, "intelligence", false)?;
        }
        for role in array(input.get("roles"), 40)? {
            let role = object(Some(role))?;
            let id = text(role.get("id"), 0, 64)?;
            if id.is_empty()
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
            {
                return Err(invalid("Invalid role id"));
            }
            text(role.get("name"), 0, 100)?;
            if let Some(section) = role.get("section") {
                let section = section.as_str().ok_or_else(|| {
                    invalid(format!(
                        "Expected 'chat' | 'kind', received {}",
                        kind(section)
                    ))
                })?;
                if !matches!(section, "chat" | "kind") {
                    return Err(invalid(format!(
                        "Invalid enum value. Expected 'chat' | 'kind', received '{section}'"
                    )));
                }
            }
        }
        if let Some(language) = input.get("language") {
            let language = text(Some(language), 0, 40)?;
            let categories = CodePointMapData::<GeneralCategory>::new();
            if language.is_empty()
                || !language.chars().all(|c| {
                    " ()-".contains(c) || GeneralCategoryGroup::Letter.contains(categories.get(c))
                })
            {
                return Err(invalid("Invalid"));
            }
        }
        serde_json::from_value(value.clone()).map_err(|error| invalid(error.to_string()))
    }
}

fn object_end(text: &str, start: usize) -> Option<usize> {
    let mut depth = 0;
    let mut quoted = false;
    let mut escaped = false;
    for (at, byte) in text.bytes().enumerate().skip(start) {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(at + 1);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

fn repair_model<'a>(value: &str, models: &'a [Model]) -> Option<&'a str> {
    let wanted = js_trim(value);
    if let Some(model) = models.iter().find(|m| m.selector == wanted) {
        return Some(&model.selector);
    }
    let folded = wanted.to_lowercase();
    let base = folded
        .rsplit_once(':')
        .filter(|(_, suffix)| !suffix.is_empty() && suffix.bytes().all(|c| c.is_ascii_lowercase()))
        .map_or(folded.as_str(), |(base, _)| base);
    if let Some(model) = models.iter().find(|m| {
        let c = m.selector.to_lowercase();
        c == folded || c == base
    }) {
        return Some(&model.selector);
    }
    let id = base.split_once('/').map_or(base, |(_, id)| id);
    let mut matches = models.iter().filter(|m| {
        m.selector
            .split_once('/')
            .is_some_and(|(_, candidate)| candidate.to_lowercase() == id)
    });
    let first = matches.next()?;
    matches.next().is_none().then_some(first.selector.as_str())
}

fn evaluate(raw: &Value, request: &Request) -> Value {
    let roles: HashMap<String, &str> = request
        .roles
        .iter()
        .map(|role| (role.id.to_lowercase(), role.id.as_str()))
        .collect();
    let mut assignments = Vec::<Value>::new();
    let mut dropped = Vec::<String>::new();
    for entry in raw["assignments"].as_array().into_iter().flatten() {
        let role = entry.get("role").and_then(Value::as_str);
        let model = entry.get("model").and_then(Value::as_str);
        let reason = entry.get("reason");
        let (Some(raw_role), Some(raw_model)) = (role, model) else {
            dropped.push(format!("malformed assignment {entry}"));
            continue;
        };
        if reason.is_some_and(|value| !value.is_string()) {
            dropped.push(format!("malformed assignment {entry}"));
            continue;
        }
        let Some(role) = roles.get(&js_trim(raw_role).to_lowercase()).copied() else {
            dropped.push(format!("unknown role \"{raw_role}\""));
            continue;
        };
        let Some(model) = repair_model(raw_model, &request.models) else {
            dropped.push(format!(
                "{role}: \"{raw_model}\" is not one of the selected models"
            ));
            continue;
        };
        if assignments.iter().any(|entry| entry["role"] == role) {
            dropped.push(format!("{role}: duplicate assignment"));
            continue;
        }
        assignments.push(json!({"role": role, "model": model, "reason": js_trim(reason.and_then(Value::as_str).unwrap_or_default())}));
    }
    let advisor = &raw["advisor"];
    let advisor = if advisor.get("enable").is_some_and(Value::is_boolean)
        && advisor.get("reason").is_none_or(Value::is_string)
    {
        json!({"enable": advisor["enable"], "reason": js_trim(advisor.get("reason").and_then(Value::as_str).unwrap_or_default())})
    } else {
        dropped.push("advisor decision missing or malformed".to_owned());
        json!({"enable": assignments.iter().any(|entry| entry["role"] == "advisor"), "reason": ""})
    };
    let sources: Vec<Value> = raw["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|source| {
            let title = source.get("title")?.as_str()?;
            let url = source.get("url")?.as_str()?;
            let folded = url.to_ascii_lowercase();
            if !(folded.starts_with("https://") || folded.starts_with("http://"))
                || url::Url::parse(url).is_err()
            {
                return None;
            }
            let title = js_trim(title);
            Some(json!({"title": if title.is_empty() { url } else { title }, "url": url}))
        })
        .collect();
    let mut plan = json!({"assignments": assignments, "advisor": advisor, "sources": sources});
    if let Some(notes) = raw
        .get("notes")
        .and_then(Value::as_str)
        .map(js_trim)
        .filter(|notes| !notes.is_empty())
    {
        plan["notes"] = Value::String(notes.to_owned());
    }
    json!({"plan": plan, "dropped": dropped})
}

pub fn parse_plan(text: &str, request: &Request) -> Result<Value, Fault> {
    let mut at = text.find('{');
    let mut candidates = Vec::new();
    while let Some(start) = at {
        let Some(end) = object_end(text, start) else {
            break;
        };
        let parsed = serde_json::from_str::<Value>(&text[start..end])
            .ok()
            .filter(|v| v.is_object() && v["assignments"].is_array());
        let next = if let Some(raw) = parsed {
            candidates.push(raw);
            end
        } else {
            start + 1
        };
        at = text[next..].find('{').map(|found| next + found);
    }
    let mut last = None;
    for raw in candidates.iter().rev() {
        let result = evaluate(raw, request);
        if result["plan"]["assignments"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
        {
            return Ok(result);
        }
        if last.is_none() {
            last = Some(result);
        }
    }
    let message = match last {
        None => "The research reply contained no plan JSON object".to_owned(),
        Some(result) => {
            let reasons = result["dropped"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("; ");
            format!(
                "The research reply proposed no valid assignment{}",
                if reasons.is_empty() {
                    String::new()
                } else {
                    format!(": {reasons}")
                }
            )
        }
    };
    Err(Fault::new(
        "model_setup_no_plan",
        format!("[model_setup_no_plan] {message}"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_captured_request_prompt_and_plan_contracts() {
        let fixture: Value = serde_json::from_str(include_str!("setup-captured.json")).unwrap();
        for (index, row) in fixture["requests"].as_array().unwrap().iter().enumerate() {
            let parsed = Request::parse(&row["input"]);
            if row["ok"] == true {
                let request = parsed.unwrap_or_else(|error| panic!("request {index}: {error:?}"));
                assert_eq!(
                    super::super::prompt::build(&request),
                    row["prompt"].as_str().unwrap(),
                    "prompt {index}"
                );
            } else {
                let error = parsed.unwrap_err();
                assert_eq!(error.code, "model_setup_invalid");
                assert_eq!(
                    error.message,
                    row["error"].as_str().unwrap(),
                    "request {index}"
                );
            }
        }
        let request = Request::parse(&fixture["request"]).unwrap();
        for (index, row) in fixture["plans"].as_array().unwrap().iter().enumerate() {
            let parsed = parse_plan(row["text"].as_str().unwrap(), &request);
            if let Some(error) = row["error"].as_str() {
                let fault = parsed.unwrap_err();
                assert_eq!(fault.code, "model_setup_no_plan");
                assert_eq!(fault.message, error, "plan {index}");
            } else {
                assert_eq!(parsed.unwrap(), row["result"], "plan {index}");
            }
        }
    }
}
