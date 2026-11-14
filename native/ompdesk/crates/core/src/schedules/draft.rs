//! The page's draft boundary, formerly `cleanDraft` / `cleanFrequency` in `src/main/schedules.ts`.

use serde_json::{Value, json};

use crate::control::js::{string_of_value, trim};

fn string(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".into(), string_of_value)
}

fn sorted(values: Option<&Value>) -> Value {
    let Some(values) = values.and_then(Value::as_array) else {
        return Value::Null;
    };
    let mut unique = Vec::with_capacity(values.len());
    for value in values {
        if !unique.contains(value) {
            unique.push(value.clone());
        }
    }
    unique.sort_by(|a, b| {
        string_of_value(a)
            .encode_utf16()
            .cmp(string_of_value(b).encode_utf16())
    });
    Value::Array(unique)
}

fn number(value: Option<&Value>) -> Value {
    let numeric = match value {
        Some(Value::Null) => Some(0.0),
        Some(Value::Bool(value)) => Some(f64::from(*value)),
        Some(Value::Number(value)) => value.as_f64(),
        Some(value @ (Value::String(_) | Value::Array(_))) => {
            let text = string_of_value(value);
            let text = trim(&text);
            if text.is_empty() {
                Some(0.0)
            } else if let Some((base, digits)) = text
                .strip_prefix("0x")
                .or_else(|| text.strip_prefix("0X"))
                .map(|s| (16, s))
                .or_else(|| {
                    text.strip_prefix("0b")
                        .or_else(|| text.strip_prefix("0B"))
                        .map(|s| (2, s))
                })
                .or_else(|| {
                    text.strip_prefix("0o")
                        .or_else(|| text.strip_prefix("0O"))
                        .map(|s| (8, s))
                })
            {
                u64::from_str_radix(digits, base).ok().map(|n| n as f64)
            } else {
                text.parse::<f64>().ok()
            }
        }
        _ => None,
    };
    numeric
        .and_then(serde_json::Number::from_f64)
        .map_or(Value::Null, Value::Number)
}

fn frequency(frequency: Option<&Value>) -> Value {
    let get = |key: &str| frequency.and_then(|frequency| frequency.get(key));
    match get("kind").and_then(Value::as_str) {
        Some("daily") => {
            json!({"kind":"daily", "time":string(get("time")), "days":sorted(get("days"))})
        }
        Some("once") => json!({"kind":"once", "at":string(get("at"))}),
        Some("event") => {
            let event = get("event");
            let field = |key: &str| event.and_then(|event| event.get(key));
            let clean = match field("source").and_then(Value::as_str) {
                Some("webhook") => {
                    json!({"source":"webhook", "key":field("key").filter(|v| !v.is_null()).map_or_else(String::new, string_of_value)})
                }
                Some("github") => {
                    json!({"source":"github", "repo":string(field("repo")), "events":sorted(field("events"))})
                }
                Some("files") => json!({"source":"files", "path":string(field("path"))}),
                Some("git") => {
                    json!({"source":"git", "repo":string(field("repo")), "branch":string(field("branch"))})
                }
                Some("session") => {
                    let mut clean = json!({"source":"session", "events":sorted(field("events"))});
                    if let Some(folder) = field("folder")
                        .and_then(Value::as_str)
                        .map(trim)
                        .filter(|s| !s.is_empty())
                    {
                        clean["folder"] = folder.into();
                    }
                    clean
                }
                // The TypeScript leaves email and unknown event shapes to `scheduleDraftProblem` unchanged.
                _ => return frequency.cloned().unwrap_or(Value::Null),
            };
            json!({"kind":"event", "event":clean})
        }
        _ => json!({"kind":"interval", "minutes":number(get("minutes"))}),
    }
}

pub(super) fn clean(draft: &Value) -> Value {
    let empty = Value::String(String::new());
    let value = |key: &str| draft.get(key).filter(|v| !v.is_null()).unwrap_or(&empty);
    let mut clean = json!({
        "name":trim(&string_of_value(value("name"))),
        "prompt":string_of_value(value("prompt")),
        "cwd":string_of_value(value("cwd")),
        "frequency":frequency(draft.get("frequency")),
        "model":draft.get("model").and_then(Value::as_str).map(trim).filter(|s| !s.is_empty()),
        "autoApprove":draft.get("autoApprove") == Some(&Value::Bool(true)),
        "enabled":draft.get("enabled") == Some(&Value::Bool(true)),
    });
    if let Some(session) = draft.get("wakeSession").filter(|v| !v.is_null()) {
        clean["wakeSession"] = string_of_value(session).into();
    }
    clean
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_injected_authority_and_normalizes_the_saved_draft() {
        let clean = clean(
            &json!({"name":"  Tidy  ", "prompt":42, "cwd":"/work", "device":"forged", "id":"forged",
            "frequency":{"kind":"daily", "time":"09:00", "days":[6,1,6,0]}, "enabled":true,
            "autoApprove":"true", "model":" model ", "wakeSession":"/session"}),
        );
        assert_eq!(
            clean,
            json!({"name":"Tidy", "prompt":"42", "cwd":"/work", "frequency":{"kind":"daily", "time":"09:00", "days":[0,1,6]}, "model":"model", "autoApprove":false, "enabled":true, "wakeSession":"/session"})
        );
    }

    #[test]
    fn preserves_webhook_generation_and_orders_event_sets() {
        assert_eq!(
            frequency(Some(
                &json!({"kind":"event", "event":{"source":"webhook", "key":null, "forged":true}})
            )),
            json!({"kind":"event", "event":{"source":"webhook", "key":""}})
        );
        assert_eq!(
            frequency(Some(
                &json!({"kind":"event", "event":{"source":"session", "events":["waiting","done","done"], "folder":" /work "}})
            )),
            json!({"kind":"event", "event":{"source":"session", "events":["done","waiting"], "folder":"/work"}})
        );
        assert_eq!(number(Some(&json!("60"))), json!(60.0));
        assert_eq!(number(Some(&json!("0x10"))), json!(16.0));
        assert_eq!(clean(&Value::Null)["name"], "");
    }
}
