//! A request line as the TypeScript server read it: `JSON.parse`, then `typeof` checks field by field. Fields stay
//! the JSON text the client wrote: what goes on to main (a tool's arguments, a message, a session's name) goes as
//! written, so main's own `JSON.parse` reads exactly what it read when the line came to it directly.

use std::collections::HashMap;

use serde_json::value::RawValue;

use super::js;

/// A JSON object's fields, each as its raw text. Of a key written twice the last counts, as in `JSON.parse`.
#[derive(Default)]
pub struct Frame(HashMap<String, Box<RawValue>>);

/// What `typeof` (and `=== null`, `Array.isArray`) tell apart.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Kind {
    Text,
    Number,
    Bool,
    Null,
    Object,
    Array,
}

pub fn kind(raw: &str) -> Kind {
    match raw.as_bytes().first() {
        Some(b'"') => Kind::Text,
        Some(b'{') => Kind::Object,
        Some(b'[') => Kind::Array,
        Some(b't' | b'f') => Kind::Bool,
        Some(b'n') => Kind::Null,
        _ => Kind::Number,
    }
}

/// A JSON string's text; half a surrogate pair, which a Rust string cannot hold, reads as U+FFFD.
pub fn text_of(raw: &str) -> Option<String> {
    if kind(raw) != Kind::Text {
        return None;
    }
    serde_json::from_str(&crate::json::whole_surrogates(raw)).ok()
}

/// A JSON number as the double JavaScript reads (`1e400` is Infinity).
pub fn number_of(raw: &str) -> Option<f64> {
    if kind(raw) != Kind::Number {
        return None;
    }
    raw.parse().ok()
}

impl Frame {
    /// The line's object; none when it is no JSON or no object.
    pub fn parse(line: &str) -> Option<Frame> {
        serde_json::from_str(line).ok().map(Frame)
    }

    /// The object a field holds, as the TypeScript read its members: an array is an object with none of them.
    pub fn member(raw: &str) -> Option<Frame> {
        match kind(raw) {
            Kind::Object => Frame::parse(raw),
            Kind::Array => Some(Frame::default()),
            _ => None,
        }
    }

    /// The field's JSON text; none where JavaScript reads `undefined`.
    pub fn raw(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(|value| value.get())
    }

    pub fn value(&self, key: &str) -> Option<&RawValue> {
        self.0.get(key).map(|value| &**value)
    }

    /// The field when `typeof` says string.
    pub fn text(&self, key: &str) -> Option<String> {
        self.raw(key).and_then(text_of)
    }

    /// The field when `typeof` says number.
    pub fn number(&self, key: &str) -> Option<f64> {
        self.raw(key).and_then(number_of)
    }

    /// `typeof frame.id === "number"`, as `JSON.stringify` writes it back.
    pub fn id(&self) -> Option<String> {
        self.number("id").map(js::json_number)
    }

    /// Whether the field is a string that is not empty (`typeof value === "string" && value.length > 0`).
    pub fn has_text(&self, key: &str) -> bool {
        self.raw(key)
            .is_some_and(|raw| kind(raw) == Kind::Text && raw != "\"\"")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_object_as_json_parse_did() {
        let frame =
            Frame::parse(r#"{"id":1,"id":2.0,"method":"tool","args":{"a":[1e3,"\ud83d"]}}"#)
                .unwrap();
        assert_eq!(frame.id().as_deref(), Some("2"));
        assert_eq!(frame.text("method").as_deref(), Some("tool"));
        // What goes on to main keeps the client's spelling, half a surrogate pair included.
        assert_eq!(frame.raw("args"), Some(r#"{"a":[1e3,"\ud83d"]}"#));
        assert!(frame.raw("tool").is_none());
        for line in ["[1]", "null", "1", "\"x\"", "nope", "{"] {
            assert!(Frame::parse(line).is_none(), "{line}");
        }
    }

    #[test]
    fn tells_types_apart_as_typeof_did() {
        let frame = Frame::parse(
            r#"{"a":"","b":"x","c":5,"d":null,"e":true,"f":[],"g":{},"h":1e400,"i":"t\ud83d"}"#,
        )
        .unwrap();
        assert!(!frame.has_text("a") && frame.has_text("b") && !frame.has_text("c"));
        assert!(!frame.has_text("d") && !frame.has_text("z"));
        assert_eq!(frame.number("c"), Some(5.0));
        assert_eq!(frame.number("b"), None);
        assert_eq!(frame.number("h"), Some(f64::INFINITY));
        assert_eq!(frame.text("i").as_deref(), Some("t\u{fffd}"));
        assert!(frame.has_text("i"));
        assert!(Frame::member(frame.raw("f").unwrap()).is_some());
        assert!(Frame::member(frame.raw("g").unwrap()).is_some());
        assert!(Frame::member(frame.raw("d").unwrap()).is_none());
        assert!(Frame::member(frame.raw("c").unwrap()).is_none());
    }
}
