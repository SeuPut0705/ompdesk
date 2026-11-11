//! gh's JSON as the TypeScript read it: `JSON.parse` over node's UTF-8 decoding, then `row.field ?? fallback` on
//! whatever came. serde_json is stricter than `JSON.parse` about an escaped half of a surrogate pair (an issue body cut
//! through an emoji); that half reads as U+FFFD, where JavaScript kept it (a Rust string cannot hold one).

use std::borrow::Cow;

use serde_json::Value;

use crate::server::Fault;

/// `JSON.parse(text)`; a text that is no JSON is a fault with serde's words (V8's differ).
pub fn parse(text: &str) -> Result<Value, Fault> {
    serde_json::from_str(&whole_surrogates(text))
        .map_err(|error| Fault::new("gh_json", error.to_string()))
}

fn escape_at(bytes: &[u8], at: usize) -> Option<u32> {
    let digits = bytes.get(at + 2..at + 6)?;
    if bytes[at] != b'\\' || bytes[at + 1] != b'u' {
        return None;
    }
    u32::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()
}

/// `text` with every `\uD800`-`\uDFFF` escape that is not half of a pair replaced by `\ufffd` (as the CLI's `json.rs`).
fn whole_surrogates(text: &str) -> Cow<'_, str> {
    let bytes = text.as_bytes();
    let mut out: Option<String> = None;
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        let Some(code) = escape_at(bytes, at) else {
            // Any other escape (`\\`, `\"`, `\n`): its second byte is never the start of another.
            at += 2;
            continue;
        };
        let paired = (0xD800..0xDC00).contains(&code)
            && escape_at(bytes, at + 6).is_some_and(|low| (0xDC00..0xE000).contains(&low));
        if paired {
            at += 12;
        } else if (0xD800..0xE000).contains(&code) {
            let out = out.get_or_insert_with(String::new);
            out.push_str(&text[copied..at]);
            out.push_str("\\ufffd");
            at += 6;
            copied = at;
        } else {
            at += 6;
        }
    }
    match out {
        Some(mut out) => {
            out.push_str(&text[copied..]);
            Cow::Owned(out)
        }
        None => Cow::Borrowed(text),
    }
}

/// `row.key`, none where JavaScript reads `undefined` or `null` (what `??` passes over).
pub fn get<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    row.get(key).filter(|value| !value.is_null())
}

/// `row.key ?? fallback`.
pub fn or(row: &Value, key: &str, fallback: impl Into<Value>) -> Value {
    get(row, key).cloned().unwrap_or_else(|| fallback.into())
}

/// `row.key?.login ?? "ghost"`.
pub fn login(row: &Value, key: &str) -> Value {
    get(row, key)
        .and_then(|user| get(user, "login"))
        .cloned()
        .unwrap_or_else(|| "ghost".into())
}

/// `row.key?.name ?? ""`.
pub fn name_of(row: &Value, key: &str) -> Value {
    get(row, key)
        .and_then(|value| get(value, "name"))
        .cloned()
        .unwrap_or_else(|| "".into())
}

/// `row.key ?? []` as the rows JavaScript mapped (a value of another shape maps to none).
pub fn rows<'a>(row: &'a Value, key: &str) -> &'a [Value] {
    get(row, key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// The rows of a whole answer (`JSON.parse(text).map(...)`).
pub fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

/// JavaScript's truthiness.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A string field, none for any other value.
pub fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_half_a_surrogate_pair_as_the_replacement_character() {
        assert_eq!(parse(r#"["a\ud83d b"]"#).unwrap(), json!(["a\u{fffd} b"]));
        assert_eq!(parse(r#"["\ud83d\ude00"]"#).unwrap(), json!(["😀"]));
        assert_eq!(parse(r#"["\\ud83d"]"#).unwrap(), json!(["\\ud83d"]));
        assert_eq!(parse("{").unwrap_err().code, "gh_json");
    }

    #[test]
    fn reads_fields_as_the_nullish_operator_does() {
        let row = json!({ "a": null, "b": 0, "user": { "login": "octo" }, "list": "x" });
        assert_eq!(or(&row, "a", "z"), json!("z"));
        assert_eq!(or(&row, "b", 5), json!(0));
        assert_eq!(or(&row, "c", false), json!(false));
        assert_eq!(login(&row, "user"), json!("octo"));
        assert_eq!(login(&row, "a"), json!("ghost"));
        assert!(rows(&row, "list").is_empty());
        assert!(!truthy(&json!("")) && !truthy(&json!(0.0)) && truthy(&json!([])));
    }
}
