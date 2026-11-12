//! The argument schemas of `ompdesk_app` actions (was `app-schema.ts`): a small strict JSON Schema subset, the same
//! objects the model is shown through `ompdesk_app_list`. Flat objects of strings, enums, numbers, booleans and string
//! arrays; anything else, and every unknown key, is refused.
//!
//! A schema stays the JSON value it is written as: the list prints it with `JSON.stringify`, so its key order is
//! part of what an agent reads.

use serde_json::{Map, Value, json};

use super::text::{js_number, json, utf16_len};

/// The longest a `json` argument may be once written out.
const JSON_VALUE_MAX: usize = 20_000;

pub type Args = Map<String, Value>;

/// `{type: "object", properties, required?, additionalProperties: false}`.
pub fn object_schema(properties: Vec<(&str, Value)>, required: &[&str]) -> Value {
    let properties: Map<String, Value> = properties
        .into_iter()
        .map(|(name, schema)| (name.to_string(), schema))
        .collect();
    let mut schema = Map::new();
    schema.insert("type".into(), json!("object"));
    schema.insert("properties".into(), Value::Object(properties));
    if !required.is_empty() {
        schema.insert("required".into(), json!(required));
    }
    schema.insert("additionalProperties".into(), json!(false));
    Value::Object(schema)
}

pub fn no_args() -> Value {
    object_schema(Vec::new(), &[])
}

fn number_of(schema: &Value, key: &str) -> Option<f64> {
    schema.get(key).and_then(Value::as_f64)
}

fn has_option(options: &Value, value: &str) -> bool {
    options
        .as_array()
        .is_some_and(|list| list.iter().any(|option| option.as_str() == Some(value)))
}

fn problem(name: &str, schema: &Value, value: &Value) -> Option<String> {
    match schema.get("type").and_then(Value::as_str) {
        Some("string") => {
            let Some(text) = value.as_str() else {
                return Some(format!("{name} must be a string"));
            };
            if let Some(options) = schema.get("enum")
                && !has_option(options, text)
            {
                let listed: Vec<&str> = options
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                return Some(format!("{name} must be one of: {}", listed.join(", ")));
            }
            let length = utf16_len(text) as f64;
            if length < number_of(schema, "minLength").unwrap_or(0.0) {
                return Some(format!("{name} is too short"));
            }
            if length > number_of(schema, "maxLength").unwrap_or(2000.0) {
                return Some(format!("{name} is too long"));
            }
            None
        }
        Some("boolean") => (!value.is_boolean()).then(|| format!("{name} must be true or false")),
        Some(kind @ ("integer" | "number")) => {
            let Some(number) = value.as_f64().filter(|number| number.is_finite()) else {
                return Some(format!("{name} must be a number"));
            };
            if kind == "integer" && number.fract() != 0.0 {
                return Some(format!("{name} must be a whole number"));
            }
            if let Some(minimum) = number_of(schema, "minimum")
                && number < minimum
            {
                return Some(format!("{name} must be at least {}", js_number(minimum)));
            }
            if let Some(maximum) = number_of(schema, "maximum")
                && number > maximum
            {
                return Some(format!("{name} must be at most {}", js_number(maximum)));
            }
            None
        }
        Some("array") => {
            let Some(items) = value.as_array() else {
                return Some(format!("{name} must be a list"));
            };
            if items.len() as f64 > number_of(schema, "maxItems").unwrap_or(20.0) {
                return Some(format!("{name} has too many items"));
            }
            let item_schema = schema.get("items").unwrap_or(&Value::Null);
            let longest = number_of(item_schema, "maxLength").unwrap_or(500.0);
            let fits = items.iter().all(|item| {
                item.as_str().is_some_and(|text| {
                    utf16_len(text) as f64 <= longest
                        && item_schema
                            .get("enum")
                            .is_none_or(|options| has_option(options, text))
                })
            });
            (!fits).then(|| format!("{name} must be a list of short strings"))
        }
        Some("json") => {
            if value.is_null() {
                return Some(format!("{name} must be a value"));
            }
            (utf16_len(&json(value)) > JSON_VALUE_MAX).then(|| format!("{name} is too long"))
        }
        _ => None,
    }
}

/// The arguments as given, or why they do not fit `schema`. `raw` absent or `null` is an empty object.
pub fn validate_args(schema: &Value, raw: Option<&Value>) -> Result<Args, String> {
    let empty = Value::Object(Map::new());
    let raw = match raw {
        None | Some(Value::Null) => &empty,
        Some(other) => other,
    };
    let Value::Object(record) = raw else {
        return Err("args must be an object".into());
    };
    let properties = schema.get("properties").and_then(Value::as_object);
    for key in record.keys() {
        if !properties.is_some_and(|properties| properties.contains_key(key)) {
            return Err(format!("unknown argument \"{key}\""));
        }
    }
    for key in schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !record.contains_key(key) {
            return Err(format!("{key} is required"));
        }
    }
    for (key, value) in record {
        let prop = properties.and_then(|properties| properties.get(key));
        if let Some(found) = prop.and_then(|prop| problem(key, prop, value)) {
            return Err(found);
        }
    }
    Ok(record.clone())
}
