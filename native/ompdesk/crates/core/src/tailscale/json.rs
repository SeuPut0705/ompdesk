//! Tailscale's JSON as the TypeScript read it: `JSON.parse`, then zod schemas that kept only the keys they named and
//! read a key that is absent, `null` or of another type as absent (`lenient`), so a Tailscale that adds or reshapes a
//! field keeps working. A reader here answers none wherever the schema answered `undefined`.

use serde_json::{Map, Number, Value};

pub type Object = Map<String, Value>;

/// `JSON.parse(text)`; none for a text that is no JSON. Half a surrogate pair reads as U+FFFD (a Rust string cannot
/// hold one).
pub fn parse(text: &str) -> Option<Value> {
    serde_json::from_str(&crate::json::whole_surrogates(text)).ok()
}

pub fn object<'a>(of: &'a Object, key: &str) -> Option<&'a Object> {
    of.get(key)?.as_object()
}

pub fn text<'a>(of: &'a Object, key: &str) -> Option<&'a str> {
    of.get(key)?.as_str()
}

/// A string that JavaScript's `||` keeps: not the empty one.
pub fn filled<'a>(of: &'a Object, key: &str) -> Option<&'a str> {
    text(of, key).filter(|text| !text.is_empty())
}

pub fn flag(of: &Object, key: &str) -> Option<bool> {
    of.get(key)?.as_bool()
}

pub fn number<'a>(of: &'a Object, key: &str) -> Option<&'a Number> {
    of.get(key)?.as_number()
}

/// `z.array(z.string())`: one item that is no string and the whole list is absent.
pub fn texts(of: &Object, key: &str) -> Option<Vec<String>> {
    of.get(key)?
        .as_array()?
        .iter()
        .map(|item| item.as_str().map(str::to_owned))
        .collect()
}

/// `Object.entries(z.record(z.object(…)))`: one value that is no object and the whole record is absent.
pub fn records<'a>(of: &'a Object, key: &str) -> Option<Vec<(&'a str, &'a Object)>> {
    entries(object(of, key)?)
        .into_iter()
        .map(|(name, value)| Some((name, value.as_object()?)))
        .collect()
}

/// `Object.entries(object)`: keys that are array indexes first, ascending, then the others as written (a key written
/// twice keeps its first place and its last value, which the map already did).
pub fn entries(of: &Object) -> Vec<(&str, &Value)> {
    let mut indexed = Vec::new();
    let mut named = Vec::new();
    for (key, value) in of {
        match array_index(key) {
            Some(index) => indexed.push((index, key.as_str(), value)),
            None => named.push((key.as_str(), value)),
        }
    }
    indexed.sort_by_key(|(index, ..)| *index);
    indexed
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(named)
        .collect()
}

/// A key JavaScript orders as a number: the canonical spelling of an integer below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0"
        || (!key.is_empty() && !key.starts_with('0') && key.bytes().all(|b| b.is_ascii_digit()));
    key.parse()
        .ok()
        .filter(|index| canonical && *index < u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_an_object_s_keys_as_javascript_does() {
        let json = parse(r#"{"b":1,"2":1,"a":1,"10":1,"01":1,"4294967295":1,"1":1,"-1":1,"b":2}"#)
            .unwrap();
        let object = json.as_object().unwrap();
        let keys: Vec<&str> = entries(object).into_iter().map(|(key, _)| key).collect();
        assert_eq!(keys, ["1", "2", "10", "b", "a", "01", "4294967295", "-1"]);
        assert_eq!(object["b"], 2);
    }

    #[test]
    fn reads_half_a_surrogate_pair_as_the_replacement_character() {
        let json = parse(r#"{"a":"x\ud83d","b":"\ud83d\ude00"}"#).unwrap();
        assert_eq!(json["a"], "x\u{fffd}");
        assert_eq!(json["b"], "😀");
        assert!(parse("").is_none() && parse("{} x").is_none() && parse("\u{feff}{}").is_none());
    }
}
