//! JSON strings shared by core subsystems: a lone surrogate escape reads as U+FFFD, since Rust cannot hold one.
use std::borrow::Cow;
fn escape_at(bytes: &[u8], at: usize) -> Option<u32> {
    let digits = bytes.get(at + 2..at + 6)?;
    if bytes[at] != b'\\' || bytes[at + 1] != b'u' {
        return None;
    }
    u32::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()
}

/// `text` with every `\uD800`-`\uDFFF` escape that is not half of a pair replaced by `\ufffd` (as the CLI's `json.rs`).
pub(crate) fn whole_surrogates(text: &str) -> Cow<'_, str> {
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

/// `text.slice(0, units)`: its first UTF-16 units; a pair cut in half ends in U+FFFD (JavaScript kept the lone half).
pub(crate) fn utf16_prefix(text: &str, units: usize) -> String {
    let mut out = String::new();
    let mut taken = 0;
    for ch in text.chars() {
        let width = ch.len_utf16();
        if taken + width > units {
            if taken < units {
                out.push('\u{fffd}');
            }
            break;
        }
        out.push(ch);
        taken += width;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cuts_text_by_utf16_unit() {
        assert_eq!(utf16_prefix("abc", 2), "ab");
        assert_eq!(utf16_prefix("a😀b", 2), "a\u{fffd}");
        assert_eq!(utf16_prefix("a😀b", 3), "a😀");
        assert_eq!(utf16_prefix("é", 300), "é");
    }
}
