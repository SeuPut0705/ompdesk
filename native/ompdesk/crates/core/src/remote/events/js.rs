//! What the TypeScript encoder got from JavaScript and the wire can show: `JSON.stringify`'s text (key order, number
//! spelling), its two equalities (`JSON.stringify(a) === JSON.stringify(b)` and node's `isDeepStrictEqual`), `===` of
//! a field, `String(value)`, truthiness, an object's key order after a spread (array-index keys first, ascending), and
//! an array's index.

use serde_json::{Map, Value};

use crate::control::js::{json_number, string_of_value};

/// `JSON.stringify(value)` of a value read from JSON: JavaScript's number spelling, its escapes, the keys as they are.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

/// The largest integer a double holds exactly: below it JavaScript spells a whole number as Rust does.
const EXACT: u64 = 1 << 53;

fn write_number(number: &serde_json::Number, out: &mut String) {
    use std::fmt::Write;
    if let Some(whole) = number.as_u64().filter(|whole| *whole <= EXACT) {
        let _ = write!(out, "{whole}");
    } else if let Some(whole) = number
        .as_i64()
        .filter(|whole| whole.unsigned_abs() <= EXACT)
    {
        let _ = write!(out, "{whole}");
    } else {
        let value = number_of(number);
        if value.fract() == 0.0 && value.abs() <= EXACT as f64 {
            // `-0` too: JavaScript spells it `0`.
            let _ = write!(out, "{}", value as i64);
        } else {
            out.push_str(&json_number(value));
        }
    }
}

fn write(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => write_number(number, out),
        Value::String(text) => write_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                write(item, out);
            }
            out.push('}');
        }
    }
}

fn write_string(text: &str, out: &mut String) {
    out.push('"');
    let bytes = text.as_bytes();
    let mut run = 0;
    for (at, byte) in bytes.iter().enumerate() {
        let escaped = match byte {
            b'"' => "\\\"",
            b'\\' => "\\\\",
            0x08 => "\\b",
            0x0c => "\\f",
            b'\n' => "\\n",
            b'\r' => "\\r",
            b'\t' => "\\t",
            0..0x20 => "",
            _ => continue,
        };
        // Every byte that needs an escape is ASCII, so the runs between them are whole characters.
        out.push_str(&text[run..at]);
        if escaped.is_empty() {
            out.push_str(&format!("\\u{byte:04x}"));
        } else {
            out.push_str(escaped);
        }
        run = at + 1;
    }
    out.push_str(&text[run..]);
    out.push('"');
}

/// `JSON.stringify(value).length`: UTF-16 units.
pub fn stringified_length(value: &Value) -> usize {
    stringify(value).encode_utf16().count()
}

fn number_of(value: &serde_json::Number) -> f64 {
    value.as_f64().unwrap_or(f64::NAN)
}

/// `JSON.stringify(a) === JSON.stringify(b)`: keys in order, numbers as spelled (`0` and `-0` alike).
pub fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => number_of(a) == number_of(b),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_json(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .zip(b)
                    .all(|((ka, va), (kb, vb))| ka == kb && same_json(va, vb))
        }
        (a, b) => a == b,
    }
}

/// node's `isDeepStrictEqual` over values read from JSON: keys in any order, numbers by `Object.is`.
pub fn deep_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => number_of(a).to_bits() == number_of(b).to_bits(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| deep_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| b.get(key).is_some_and(|other| deep_equal(value, other)))
        }
        (a, b) => a == b,
    }
}

/// `a === b` of two fields, `None` being `undefined`: an object or array is never `===` another one read apart.
pub fn strict_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => number_of(a) == number_of(b),
        (Some(Value::Array(_) | Value::Object(_)), _)
        | (_, Some(Value::Array(_) | Value::Object(_))) => false,
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// `String(value)`, `None` being `undefined`.
pub fn string_of(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".into(), string_of_value)
}

/// JavaScript's truthiness, `None` being `undefined`.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => {
            let number = number_of(number);
            number != 0.0 && !number.is_nan()
        }
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// The array index a key names (`"0"`, `"17"`, never `"01"` or past 2^32 − 2), as JavaScript orders them first.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

/// `object[key] = value` on an object JavaScript built: an existing key keeps its place, a new array-index key goes
/// among the leading index keys in ascending order, any other new key last.
pub fn set(map: &mut Map<String, Value>, key: impl Into<String>, value: Value) {
    let key = key.into();
    if let Some(slot) = map.get_mut(&key) {
        *slot = value;
        return;
    }
    let Some(index) = array_index(&key) else {
        map.insert(key, value);
        return;
    };
    let at = map
        .keys()
        .take_while(|other| array_index(other).is_some_and(|other| other < index))
        .count();
    map.shift_insert(at, key, value);
}

/// `{...base, key: value}`: a copy with one field set.
pub fn with(base: &Map<String, Value>, key: &str, value: Value) -> Map<String, Value> {
    replaced(base, vec![(key, value)])
}

/// `{...base, a: x, b: y}`: a copy with these fields set, the replaced values never copied.
pub fn replaced(base: &Map<String, Value>, fields: Vec<(&str, Value)>) -> Map<String, Value> {
    let mut fields: Vec<(&str, Option<Value>)> = fields
        .into_iter()
        .map(|(key, value)| (key, Some(value)))
        .collect();
    let mut out = Map::with_capacity(base.len() + fields.len());
    for (key, value) in base {
        let substitute = fields
            .iter_mut()
            .find(|(name, value)| *name == key && value.is_some())
            .and_then(|(_, value)| value.take());
        out.insert(key.clone(), substitute.unwrap_or_else(|| value.clone()));
    }
    for (key, value) in fields {
        if let Some(value) = value {
            set(&mut out, key, value);
        }
    }
    out
}

/// `const {a, b, ...rest} = base`: `rest`.
pub fn without(base: &Map<String, Value>, keys: &[&str]) -> Map<String, Value> {
    base.iter()
        .filter(|(key, _)| !keys.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// `{...a, ...b}`.
pub fn spread(a: &Map<String, Value>, b: &Map<String, Value>) -> Map<String, Value> {
    let mut copy = a.clone();
    for (key, value) in b {
        set(&mut copy, key.clone(), value.clone());
    }
    copy
}

/// `delete object[key]`.
pub fn delete(map: &mut Map<String, Value>, key: &str) {
    map.shift_remove(key);
}

/// The element `list[index]` reads for an index read from JSON: a number or a string that names an array index.
pub fn index_of(index: Option<&Value>) -> Option<usize> {
    match index? {
        Value::Number(number) => {
            let number = number_of(number);
            (number >= 0.0 && number.fract() == 0.0 && number < f64::from(u32::MAX))
                .then_some(number as usize)
        }
        Value::String(text) => array_index(text).map(|index| index as usize),
        _ => None,
    }
}

/// `value[index]` of an array; `None` for anything else.
pub fn element(value: Option<&Value>, index: Option<usize>) -> Option<&Value> {
    value?.as_array()?.get(index?)
}

/// A JSON number that is an integer (`Number.isInteger`), as `f64`.
pub fn integer(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number.fract() == 0.0).then_some(number)
}

/// The field `key` of `value` when it is an object (`value?.[key]`).
pub fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

/// `value.type` when it is a string.
pub fn type_of(value: &Value) -> Option<&str> {
    value.get("type")?.as_str()
}

/// A JSON number for a length or offset.
pub fn count(value: usize) -> Value {
    Value::from(value as u64)
}
