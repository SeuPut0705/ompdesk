//! What the TypeScript server got from JavaScript for free and its clients could see: how a number is spelled in a
//! message or an echoed id, `String(value)` of whatever a client sent as its protocol, `trim()`'s idea of a blank
//! line, and node's `path.isAbsolute`.

use serde_json::Value;

/// `String(number)` (ECMAScript's Number::toString, radix 10).
pub fn number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value == 0.0 {
        return "0".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    // Rust's `{:e}` gives the shortest digits that read back as the same double, which is what JavaScript prints.
    let spelled = format!("{:e}", value.abs());
    let (mantissa, exponent) = spelled.split_once('e').unwrap_or((&spelled, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let count = digits.len() as i32;
    // The decimal point sits after `point` digits.
    let point = exponent + 1;
    let body = if count <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - count) as usize))
    } else if 0 < point && point <= 21 {
        let (whole, fraction) = digits.split_at(point as usize);
        format!("{whole}.{fraction}")
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let sign = if exponent < 0 { '-' } else { '+' };
        let (first, rest) = digits.split_at(1);
        if rest.is_empty() {
            format!("{first}e{sign}{}", exponent.abs())
        } else {
            format!("{first}.{rest}e{sign}{}", exponent.abs())
        }
    };
    if value < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

/// A number as `JSON.stringify` writes it: what cannot be a JSON number is `null`.
pub fn json_number(value: f64) -> String {
    if value.is_finite() {
        number(value)
    } else {
        "null".into()
    }
}

/// `String(value)` of a parsed JSON value.
pub(crate) fn string_of_value(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(spelled) => number(spelled.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        // `Array.prototype.join`: null joins as nothing.
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => string_of_value(item),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(value)` of a field's raw JSON text; an absent field is `undefined`.
pub fn string_of(raw: Option<&str>) -> String {
    let Some(raw) = raw else {
        return "undefined".into();
    };
    // A number is read here, not by serde: `1e400` is Infinity in JavaScript and an error there.
    if let Ok(value) = raw.parse::<f64>() {
        return number(value);
    }
    match serde_json::from_str::<Value>(&crate::json::whole_surrogates(raw)) {
        Ok(value) => string_of_value(&value),
        Err(_) => raw.to_owned(),
    }
}

/// What `String.prototype.trim` removes: ECMAScript's WhiteSpace and LineTerminator.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `line.trim().length === 0`.
pub fn is_blank(line: &str) -> bool {
    line.chars().all(is_js_space)
}

/// `text.trim()`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// node's `path.win32.isAbsolute`: a leading separator, or a drive letter, a colon and a separator.
pub fn is_absolute_win32(path: &str) -> bool {
    let bytes = path.as_bytes();
    let separator = |byte: u8| byte == b'/' || byte == b'\\';
    match bytes {
        [first, ..] if separator(*first) => true,
        [drive, b':', third, ..] => drive.is_ascii_alphabetic() && separator(*third),
        _ => false,
    }
}

/// node's `path.posix.isAbsolute`.
pub fn is_absolute_posix(path: &str) -> bool {
    path.starts_with('/')
}

/// node's `path.isAbsolute` on this platform.
pub fn is_absolute(path: &str) -> bool {
    if cfg!(windows) {
        is_absolute_win32(path)
    } else {
        is_absolute_posix(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::tests::captured;

    #[test]
    fn spells_numbers_as_javascript_did() {
        let rows = captured("numbers");
        assert_eq!(rows.len(), 37);
        for row in rows {
            let text = row[0].as_str().unwrap();
            let value: f64 = text.parse().unwrap();
            assert_eq!(number(value), row[1].as_str().unwrap(), "{text}");
        }
    }

    #[test]
    fn reads_absolute_paths_as_node_did() {
        let rows = captured("absolute");
        assert_eq!(rows.len(), 22);
        for row in rows {
            let path = row[0].as_str().unwrap();
            assert_eq!(is_absolute_win32(path), row[1].as_bool().unwrap(), "{path}");
            assert_eq!(is_absolute_posix(path), row[2].as_bool().unwrap(), "{path}");
        }
    }

    #[test]
    fn a_blank_line_is_what_trim_empties() {
        assert!(is_blank(""));
        assert!(is_blank(" \t\r\u{a0}\u{feff}\u{2028}\u{3000}"));
        assert!(!is_blank("\u{85}"));
        assert!(!is_blank(" x "));
        assert_eq!(trim("\u{feff} a b\r\n"), "a b");
    }

    #[test]
    fn spells_any_value_as_string_did() {
        for (raw, expected) in [
            (None, "undefined"),
            (Some("2"), "2"),
            (Some("\"1\""), "1"),
            (Some("null"), "null"),
            (Some("1.5"), "1.5"),
            (
                Some("[1,[2,null],\"a\",{\"b\":1},true]"),
                "1,2,,a,[object Object],true",
            ),
            (Some("{\"a\":1}"), "[object Object]"),
            (Some("true"), "true"),
            (Some("1e21"), "1e+21"),
            (Some("1e-7"), "1e-7"),
            (Some("1e400"), "Infinity"),
        ] {
            assert_eq!(string_of(raw), expected, "{raw:?}");
        }
    }
}
