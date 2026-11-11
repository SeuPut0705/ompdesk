//! Reading JSON the way JavaScript's `JSON.parse` over a UTF-8 decoded stream does, where serde_json is stricter:
//! bytes that are not UTF-8 and `\uXXXX` escapes of half a surrogate pair become U+FFFD instead of an error.
//! OMPdesk cuts titles by UTF-16 unit, so a title cut through an emoji arrives as a lone `\ud83d`; refusing that
//! line would leave its request without an answer for good.

use std::borrow::Cow;

use serde_json::Value;

pub fn parse(bytes: &[u8]) -> Option<Value> {
    read(bytes).ok()
}

/// Why a text was not read: serde_json stops at 128 levels of nesting, which `JSON.parse` reads.
#[derive(Debug, PartialEq, Eq)]
pub enum Unread {
    NotJson,
    TooDeep,
}

pub fn read(bytes: &[u8]) -> Result<Value, Unread> {
    let text = String::from_utf8_lossy(bytes);
    serde_json::from_str(&whole_surrogates(&text)).map_err(|error| {
        if error.to_string().starts_with("recursion limit exceeded") {
            Unread::TooDeep
        } else {
            Unread::NotJson
        }
    })
}

fn escape_at(bytes: &[u8], at: usize) -> Option<u32> {
    let digits = bytes.get(at + 2..at + 6)?;
    if bytes[at] != b'\\' || bytes[at + 1] != b'u' {
        return None;
    }
    u32::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()
}

/// `text` with every `\uD800`-`\uDFFF` escape that is not half of a pair replaced by `\ufffd`.
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

/// The length of `bytes` in UTF-16 units, as JavaScript counts a decoded string.
pub fn utf16_units(bytes: &[u8]) -> usize {
    bytes
        .iter()
        .map(|b| match b {
            0x80..=0xBF => 0,
            0xF0..=0xFF => 2,
            _ => 1,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn half_surrogates_read_as_the_replacement_character() {
        for (text, expected) in [
            (r#"{"t":"a\ud83d"}"#, json!({"t": "a\u{fffd}"})),
            (r#"{"t":"\ude00b"}"#, json!({"t": "\u{fffd}b"})),
            (r#"{"t":"\ud83d\ud83d\ude00"}"#, json!({"t": "\u{fffd}😀"})),
            (
                r#"{"t":"\ud83dx\ude00"}"#,
                json!({"t": "\u{fffd}x\u{fffd}"}),
            ),
            (r#"{"t":"\ud83d\ude00"}"#, json!({"t": "😀"})),
            (r#"{"t":"\\ud83d"}"#, json!({"t": "\\ud83d"})),
            (r#"{"t":"\\\ud83d"}"#, json!({"t": "\\\u{fffd}"})),
            (r#"{"t":"가\n\u00e9"}"#, json!({"t": "가\né"})),
        ] {
            assert_eq!(parse(text.as_bytes()), Some(expected), "{text}");
        }
    }

    #[test]
    fn bytes_that_are_not_utf8_read_as_the_replacement_character() {
        assert_eq!(
            parse(b"{\"t\":\"a\xffb\"}"),
            Some(json!({"t": "a\u{fffd}b"}))
        );
        assert_eq!(parse(b"{\"t\":"), None);
        assert_eq!(parse(br#"{"t":"\ud8"}"#), None);
    }

    #[test]
    fn counts_utf16_units() {
        assert_eq!(utf16_units("abc".as_bytes()), 3);
        assert_eq!(utf16_units("가나".as_bytes()), 2);
        assert_eq!(utf16_units("é😀".as_bytes()), 3);
    }
}
