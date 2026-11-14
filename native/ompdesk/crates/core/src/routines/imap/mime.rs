use std::collections::BTreeMap;

use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use encoding_rs::{Encoding, UTF_8};

use crate::fs::order::{is_js_space, js_trim};
use crate::routines::text::clip;

const BASE64: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

pub(super) fn headers(raw: &[u8]) -> BTreeMap<String, String> {
    let raw = String::from_utf8_lossy(raw);
    let mut lines = Vec::<String>::new();
    for line in raw.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.starts_with([' ', '\t'])
            && let Some(before) = lines.last_mut()
        {
            before.push(' ');
            before.push_str(line.trim_start_matches([' ', '\t']));
        } else {
            lines.push(line.to_owned());
        }
    }
    let mut headers = BTreeMap::<String, String>::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':').filter(|(name, _)| !name.is_empty()) else {
            continue;
        };
        let name = js_trim(name).to_lowercase();
        let value = words(js_trim(value));
        if let Some(previous) = headers
            .get_mut(&name)
            .filter(|previous| !previous.is_empty())
        {
            previous.push_str(", ");
            previous.push_str(&value);
        } else {
            headers.insert(name, value);
        }
    }
    headers
}

fn compact_words(text: &str) -> String {
    let mut compact = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(end) = rest.find("?=") {
        compact.push_str(&rest[..end + 2]);
        rest = &rest[end + 2..];
        let after = rest.trim_start_matches(is_js_space);
        if after.starts_with("=?") {
            rest = after;
        }
    }
    compact.push_str(rest);
    compact
}

pub(super) fn words(text: &str) -> String {
    let compact = compact_words(text);
    let mut rest = compact.as_str();
    let mut decoded = String::with_capacity(rest.len());
    while let Some(start) = rest.find("=?") {
        decoded.push_str(&rest[..start]);
        rest = &rest[start..];
        let Some(end) = rest[2..].find("?=").map(|end| end + 4) else {
            decoded.push_str(rest);
            return decoded;
        };
        let whole = &rest[..end];
        let encoded = &whole[2..whole.len() - 2];
        let fields: Vec<&str> = encoded.splitn(3, '?').collect();
        let value = (|| {
            let [charset, kind, text] = fields.as_slice() else {
                return None;
            };
            let encoding = Encoding::for_label(charset.as_bytes())?;
            let bytes = if kind.eq_ignore_ascii_case("B") {
                base64(text.as_bytes(), false)
            } else if kind.eq_ignore_ascii_case("Q") {
                quoted_printable(text.replace('_', " ").as_bytes())
            } else {
                return None;
            };
            Some(encoding.decode_with_bom_removal(&bytes).0.into_owned())
        })();
        decoded.push_str(value.as_deref().unwrap_or(whole));
        rest = &rest[end..];
    }
    decoded.push_str(rest);
    decoded
}

fn base64(text: &[u8], body: bool) -> Vec<u8> {
    let mut clean: Vec<u8> = text
        .iter()
        .copied()
        .filter(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        .collect();
    if body {
        clean.truncate(clean.len() - clean.len() % 4);
    }
    if let Some(padding) = clean.iter().position(|byte| *byte == b'=') {
        clean.truncate(padding);
    }
    if clean.len() % 4 == 1 {
        clean.pop();
    }
    BASE64.decode(clean).unwrap_or_default()
}

fn quoted_printable(text: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        if text[at] == b'=' {
            if text.get(at + 1) == Some(&b'\n') {
                at += 2;
                continue;
            }
            if text.get(at + 1..at + 3) == Some(b"\r\n") {
                at += 3;
                continue;
            }
            if let Some(hex) = text
                .get(at + 1..at + 3)
                .and_then(|hex| std::str::from_utf8(hex).ok())
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
            {
                bytes.push(hex);
                at += 3;
                continue;
            }
        }
        bytes.push(text[at]);
        at += 1;
    }
    bytes
}

fn parameter<'a>(content_type: &'a str, name: &str) -> &'a str {
    let lower = content_type.to_ascii_lowercase();
    let Some(start) = lower.find(name) else {
        return "";
    };
    let tail = content_type[start + name.len()..].trim_start_matches(is_js_space);
    let Some(tail) = tail.strip_prefix('=') else {
        return "";
    };
    let tail = tail
        .trim_start_matches(is_js_space)
        .strip_prefix('"')
        .unwrap_or_else(|| tail.trim_start_matches(is_js_space));
    js_trim(tail.split(['"', ';']).next().unwrap_or_default())
}

fn body(bytes: &[u8], transfer: &str, charset: &str) -> String {
    let converted;
    let bytes = match js_trim(transfer).to_ascii_lowercase().as_str() {
        "base64" => {
            converted = base64(bytes, true);
            &converted
        }
        "quoted-printable" => {
            converted = quoted_printable(bytes);
            &converted
        }
        _ => bytes,
    };
    let encoding = Encoding::for_label(charset.as_bytes()).unwrap_or(UTF_8);
    encoding.decode_with_bom_removal(bytes).0.into_owned()
}

pub(super) fn snippet(headers: &BTreeMap<String, String>, bytes: &[u8]) -> String {
    let content_type = headers
        .get("content-type")
        .map_or("text/plain", String::as_str);
    let mut text = if js_trim(content_type)
        .to_ascii_lowercase()
        .starts_with("multipart/")
    {
        let boundary = parameter(content_type, "boundary");
        if boundary.is_empty() {
            String::new()
        } else {
            part_text(bytes, boundary)
        }
    } else {
        body(
            bytes,
            headers
                .get("content-transfer-encoding")
                .map_or("", String::as_str),
            parameter(content_type, "charset"),
        )
    };
    if js_trim(content_type)
        .to_ascii_lowercase()
        .starts_with("text/html")
    {
        text = strip_html(&text);
    }
    clip(&text, usize::MAX).chars().take(1_000).collect()
}

fn find(bytes: &[u8], needle: &[u8]) -> Option<usize> {
    bytes
        .windows(needle.len())
        .position(|window| window == needle)
}

fn part_text(bytes: &[u8], boundary: &str) -> String {
    let boundary = format!("--{boundary}");
    let mut rest = bytes;
    let mut pick = None;
    while let Some(start) = find(rest, boundary.as_bytes()) {
        rest = &rest[start + boundary.len()..];
        let end = find(rest, boundary.as_bytes()).unwrap_or(rest.len());
        let part = &rest[..end];
        let separator = find(part, b"\r\n\r\n")
            .map(|at| (at, 4))
            .or_else(|| find(part, b"\n\n").map(|at| (at, 2)));
        let Some((split, width)) = separator else {
            continue;
        };
        let headers = headers(&part[..split]);
        let content_type = headers
            .get("content-type")
            .map_or("text/plain", String::as_str);
        let lower = js_trim(content_type).to_ascii_lowercase();
        let plain = lower.starts_with("text/plain");
        if plain || (pick.is_none() && lower.starts_with("text/")) {
            let text = body(
                &part[split + width..],
                headers
                    .get("content-transfer-encoding")
                    .map_or("", String::as_str),
                parameter(content_type, "charset"),
            );
            pick = Some(if lower.starts_with("text/html") {
                strip_html(&text)
            } else {
                text
            });
            if plain {
                break;
            }
        }
    }
    pick.unwrap_or_default()
}

fn strip_html(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut cleaned = String::with_capacity(html.len());
    let mut at = 0;
    while at < html.len() {
        let next = ["script", "style"]
            .into_iter()
            .filter_map(|tag| {
                let start = lower[at..].find(&format!("<{tag}"))? + at;
                let end_tag = format!("</{tag}>");
                let end = lower[start..].find(&end_tag)? + start + end_tag.len();
                Some((start, end))
            })
            .min_by_key(|(start, _)| *start);
        let Some((start, end)) = next else {
            cleaned.push_str(&html[at..]);
            break;
        };
        cleaned.push_str(&html[at..start]);
        cleaned.push(' ');
        at = end;
    }
    let mut text = String::with_capacity(cleaned.len());
    let mut rest = cleaned.as_str();
    while let Some(start) = rest.find('<') {
        text.push_str(&rest[..start]);
        rest = &rest[start..];
        if let Some(end) = rest[1..]
            .find('>')
            .map(|end| end + 1)
            .filter(|end| *end > 1)
        {
            text.push(' ');
            rest = &rest[end + 1..];
        } else {
            text.push('<');
            rest = &rest[1..];
        }
    }
    text.push_str(rest);
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}
