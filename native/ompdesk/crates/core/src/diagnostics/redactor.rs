use std::borrow::Cow;
use std::sync::LazyLock;

use regress::{Match, Regex};

use crate::control::js::is_blank;

const SECRET_NAME: &str = r"[\w.-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|secret|token(?!s\b)|passw(?:or)?d|passwd|pwd|credentials?|authorization|cookie)[\w.-]*";

struct Patterns {
    url: Regex,
    pem: Regex,
    jwt: Regex,
    vendor: Regex,
    bearer: Regex,
    secret_field: Regex,
    inert_quotes: Regex,
    inert_value: Regex,
    key_value: Regex,
    hex: Regex,
    base64: Regex,
    email: Regex,
    host: Regex,
    ipv4: Regex,
    ula: Regex,
    link_local: Regex,
    windows_home: Regex,
    posix_home: Regex,
}

fn regex(pattern: &str, insensitive: bool) -> Regex {
    Regex::with_flags(pattern, if insensitive { "i" } else { "" })
        .expect("canonical diagnostics regex must compile")
}

static PATTERNS: LazyLock<Patterns> = LazyLock::new(|| Patterns {
    url: regex(r"(//)[^\s/:@]+:[^\s/@]+@", false),
    pem: regex(r"-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)", false),
    jwt: regex(r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*", false),
    vendor: regex(r"\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9_-]{16,}|\bxox[abposr]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}", false),
    bearer: regex(r"\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}", true),
    secret_field: regex(&format!("^{SECRET_NAME}$"), true),
    inert_quotes: regex(r#"^\\?["']|["']$"#, false),
    inert_value: regex(r"^(?:true|false|null|undefined|none|\d+)$", true),
    key_value: regex(&format!(r#"(\\?["']?\b{SECRET_NAME}\\?["']?[ \t]*[:=][ \t]*)("[^"\n]*"|'[^'\n]*'|\\?"?[^\s"'\\,;&}}]+)"#), true),
    hex: regex(r"(?<![\w-])[0-9a-fA-F]{32,}(?![\w-])", false),
    base64: regex(r"(?<![\w+=-])[A-Za-z0-9_+=-]{32,}(?![\w+=-])", false),
    email: regex(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}", false),
    host: regex(r"\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net\b", true),
    ipv4: regex(r"(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w]|\.\d)", false),
    ula: regex(r"(?<![\w:])f[cd][0-9a-f]{2}(?::[0-9a-f]{0,4}){2,7}(?![\w:])", true),
    link_local: regex(r"(?<![\w:])fe80(?::[0-9a-f]{0,4}){1,7}(?:%[\w.-]+)?(?![\w:])", true),
    windows_home: regex(r#"(?<![\w])[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)(?!(?:Public|Default|Shared)\b)(?:[^\\/\s"'<>|:*?]+(?: [^\\/\s"'<>|:*?]+){0,2}(?=[\\/])|[^\\/\s"'<>|:*?]+)"#, false),
    posix_home: regex(r#"(?<![\w.~-])\/(?:Users|home)\/(?!(?:Shared|Guest)\b)[^/\s"'<>|:\\]+"#, false),
});

fn replace(text: Vec<u16>, re: &Regex, f: impl Fn(&[u16], &Match, &mut Vec<u16>)) -> Vec<u16> {
    let mut matches = re.find_from_ucs2(&text, 0);
    let Some(first) = matches.next() else {
        drop(matches);
        return text;
    };
    let mut out = Vec::with_capacity(text.len());
    let mut last = 0;
    for m in std::iter::once(first).chain(matches) {
        out.extend_from_slice(&text[last..m.start()]);
        f(&text, &m, &mut out);
        last = m.end();
    }
    out.extend_from_slice(&text[last..]);
    out
}

fn literal(text: Vec<u16>, re: &Regex, replacement: &str) -> Vec<u16> {
    replace(text, re, |_, _, out| out.extend(replacement.encode_utf16()))
}

fn capture<'a>(text: &'a [u16], m: &Match, index: usize) -> &'a [u16] {
    &text[m.group(index).expect("canonical capture exists")]
}

pub(super) fn inert(raw: &[u16]) -> bool {
    let p = &*PATTERNS;
    let mut matches = p.inert_quotes.find_from_ucs2(raw, 0);
    let value = if let Some(first) = matches.next() {
        let mut stripped = Vec::with_capacity(raw.len());
        let mut last = 0;
        for found in std::iter::once(first).chain(matches) {
            stripped.extend_from_slice(&raw[last..found.start()]);
            last = found.end();
        }
        stripped.extend_from_slice(&raw[last..]);
        Cow::Owned(stripped)
    } else {
        Cow::Borrowed(raw)
    };
    value.is_empty()
        || value[0] == 60
        || p.inert_value.find_from_ucs2(&value, 0).next().is_some()
}

fn credentials(mut text: Vec<u16>) -> Vec<u16> {
    let p = &*PATTERNS;
    text = replace(text, &p.url, |text, m, out| {
        out.extend_from_slice(capture(text, m, 1));
        out.extend("<secret>@".encode_utf16());
    });
    text = literal(text, &p.pem, "<secret>");
    text = literal(text, &p.jwt, "<token>");
    text = literal(text, &p.vendor, "<token>");
    text = replace(text, &p.bearer, |text, m, out| {
        out.extend_from_slice(capture(text, m, 1));
        out.extend("<token>".encode_utf16());
    });
    text = replace(text, &p.key_value, |text, m, out| {
        if inert(capture(text, m, 2)) {
            out.extend_from_slice(&text[m.range()]);
        } else {
            out.extend_from_slice(capture(text, m, 1));
            out.extend("<secret>".encode_utf16());
        }
    });
    text = literal(text, &p.hex, "<token>");
    replace(text, &p.base64, |text, m, out| {
        let run = &text[m.range()];
        if run.iter().any(|c| (48..=57).contains(c))
            && run.iter().any(|c| (97..=122).contains(c))
            && run.iter().any(|c| (65..=90).contains(c)) {
            out.extend("<token>".encode_utf16());
        } else {
            out.extend_from_slice(run);
        }
    })
}

pub fn redact_secret_text(text: &str) -> String {
    String::from_utf16(&credentials(text.encode_utf16().collect())).expect("valid UTF-16 input")
}

pub(super) fn redact_units(text: Vec<u16>) -> Vec<u16> {
    let p = &*PATTERNS;
    let mut text = credentials(text);
    text = replace(text, &p.email, |text, m, out| {
        let value = &text[m.range()];
        if value.starts_with(&[103, 105, 116, 64]) {
            out.extend_from_slice(value);
        } else {
            out.extend("<email>".encode_utf16());
        }
    });
    text = literal(text, &p.host, "<tailnet-host>");
    text = replace(text, &p.ipv4, |text, m, out| {
        let octets: [u16; 4] = std::array::from_fn(|i| {
            capture(text, m, i + 1).iter().fold(0, |n, c| n * 10 + *c - 48)
        });
        let replacement = if octets.iter().any(|n| *n > 255) { None } else {
            match (octets[0], octets[1]) {
                (100, 64..=127) => Some("<tailnet-ip>"),
                (10, _) | (172, 16..=31) | (192, 168) => Some("<lan-ip>"),
                _ => None,
            }
        };
        if let Some(replacement) = replacement {
            out.extend(replacement.encode_utf16());
        } else {
            out.extend_from_slice(&text[m.range()]);
        }
    });
    text = replace(text, &p.ula, |text, m, out| {
        let value = &text[m.range()];
        let tailnet = value.len() >= 14 && value[..14].iter().zip("fd7a:115c:a1e0".bytes())
            .all(|(a, b)| *a <= 127 && (*a as u8).eq_ignore_ascii_case(&b));
        out.extend(if tailnet { "<tailnet-ip>" } else { "<lan-ip>" }.encode_utf16());
    });
    text = literal(text, &p.link_local, "<lan-ip>");
    text = literal(text, &p.windows_home, "~");
    literal(text, &p.posix_home, "~")
}

pub(super) fn secret_field(text: &[u16]) -> bool {
    PATTERNS.secret_field.find_from_ucs2(text, 0).next().is_some()
}

pub fn redact_diagnostics_text(text: &str) -> String {
    String::from_utf16(&redact_units(text.encode_utf16().collect())).expect("valid UTF-16 input")
}

fn redact_json(text: &str, indent: bool) -> Option<String> {
    super::json::redact(text, indent)
}

pub fn redact_diagnostics_file(name: &str, text: &str) -> String {
    if name.get(name.len().saturating_sub(6)..).is_some_and(|suffix| suffix.eq_ignore_ascii_case(".jsonl")) {
        return text.split('\n').map(|line| {
            if is_blank(line) { line.to_owned() } else {
                redact_json(line, false).unwrap_or_else(|| redact_diagnostics_text(line))
            }
        }).collect::<Vec<_>>().join("\n");
    }
    if name.get(name.len().saturating_sub(5)..).is_some_and(|suffix| suffix.eq_ignore_ascii_case(".json")) {
        let body = text.strip_suffix('\n').unwrap_or(text);
        let indent = body.starts_with("{\n") || body.starts_with("[\n");
        return match redact_json(body, indent) {
            Some(mut output) => {
                if text.ends_with('\n') { output.push('\n'); }
                output
            }
            None => redact_diagnostics_text(text),
        };
    }
    redact_diagnostics_text(text)
}
