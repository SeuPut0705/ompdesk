//! Credential-marker rules ported from `worktree-facts.ts` / gui-bridge `redactor.ts`.
//! File bytes are Latin1 there, so the scanner uses byte-wise JS ASCII word boundaries.
//! Later diagnostic address/home passes cannot consume `<secret>` or `<token>` markers.
use std::io::Read;
use std::path::Path;

const MAX: u64 = 16 * 1024 * 1024;

fn secret_name(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    name == ".env"
        || name.starts_with(".env.") && name.len() > 5
        || matches!(name.as_str(), ".envrc" | ".npmrc" | ".netrc" | ".pypirc")
        || ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]
            .iter()
            .any(|key| name == *key || name == format!("{key}.pub"))
        || name.starts_with("credentials")
        || name.contains("secret")
        || [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".kdbx"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
}

fn word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}
fn space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c | 0xa0)
}
fn boundary(bytes: &[u8], i: usize) -> bool {
    i == 0 || !word(bytes[i - 1])
}
fn run(bytes: &[u8], mut i: usize, allowed: impl Fn(u8) -> bool) -> usize {
    let start = i;
    while i < bytes.len() && allowed(bytes[i]) {
        i += 1;
    }
    i - start
}
fn secret_field(name: &str) -> bool {
    let s = name.to_ascii_lowercase();
    [
        "apikey",
        "api_key",
        "api-key",
        "accesskey",
        "access_key",
        "access-key",
        "privatekey",
        "private_key",
        "private-key",
        "clientsecret",
        "client_secret",
        "client-secret",
        "secret",
        "password",
        "passwd",
        "pwd",
        "credential",
        "authorization",
        "cookie",
    ]
    .iter()
    .any(|v| s.contains(v))
        || s.match_indices("token").any(|(i, _)| {
            !s[i + 5..].starts_with('s') || s.as_bytes().get(i + 6).is_some_and(|c| word(*c))
        })
}
fn inert(value: &str) -> bool {
    let value = value
        .strip_prefix("\\\"")
        .or_else(|| value.strip_prefix("\\'"))
        .or_else(|| value.strip_prefix('"'))
        .or_else(|| value.strip_prefix('\''))
        .unwrap_or(value);
    let value = value
        .strip_suffix('"')
        .or_else(|| value.strip_suffix('\''))
        .unwrap_or(value);
    value.is_empty()
        || value.starts_with('<')
        || value.bytes().all(|c| c.is_ascii_digit())
        || ["true", "false", "null", "undefined", "none"]
            .iter()
            .any(|s| value.eq_ignore_ascii_case(s))
}

// The markers already in the input matter: replacement can remove one before adding another.
fn redact_pass(input: &[u8], pass: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let tail = &input[i..];
        let mut consumed = 0;
        let mut replacement: &[u8] = b"<token>";
        if pass == 0 && tail.starts_with(b"//") {
            let user = run(tail, 2, |c| !space(c) && !b"/:@".contains(&c));
            let colon = 2 + user;
            if user > 0 && tail.get(colon) == Some(&b':') {
                let password = run(tail, colon + 1, |c| !space(c) && !b"/@".contains(&c));
                if password > 0 && tail.get(colon + 1 + password) == Some(&b'@') {
                    out.extend_from_slice(b"//<secret>@");
                    i += colon + password + 2;
                    continue;
                }
            }
        }
        if pass == 4
            && boundary(input, i)
            && tail.len() >= 6
            && tail[..6].eq_ignore_ascii_case(b"bearer")
        {
            let spaces = run(tail, 6, space);
            let start = 6 + spaces;
            let value = run(tail, start, |c| {
                c.is_ascii_alphanumeric() || b"._~+/=-".contains(&c)
            });
            if spaces > 0 && value >= 8 {
                out.extend_from_slice(&tail[..start]);
                out.extend_from_slice(b"<token>");
                i += start + value;
                continue;
            }
        }
        if pass == 1 && tail.starts_with(b"-----BEGIN ") {
            if let Some(end) = tail[11..].windows(5).position(|w| w == b"-----") {
                if tail[11..11 + end]
                    .iter()
                    .all(|c| c.is_ascii_uppercase() || *c == b' ')
                    && end > 0
                {
                    let content = 11 + end + 5;
                    consumed = (content..tail.len())
                        .find_map(|p| {
                            if !tail[p..].starts_with(b"-----END ") {
                                return None;
                            }
                            let size = run(tail, p + 9, |c| c.is_ascii_uppercase() || c == b' ');
                            (size > 0 && tail[p + 9 + size..].starts_with(b"-----"))
                                .then_some(p + 9 + size + 5)
                        })
                        .unwrap_or(tail.len());
                    replacement = b"<secret>";
                }
            }
        }
        if pass == 3 && boundary(input, i) {
            let prefixes: [(&[u8], usize, u8); 13] = [
                (b"ghp_", 20, 0),
                (b"gho_", 20, 0),
                (b"ghu_", 20, 0),
                (b"ghs_", 20, 0),
                (b"ghr_", 20, 0),
                (b"github_pat_", 20, 3),
                (b"sk-", 16, 1),
                (b"xoxa-", 10, 2),
                (b"xoxb-", 10, 2),
                (b"xoxo-", 10, 2),
                (b"xoxp-", 10, 2),
                (b"xoxs-", 10, 2),
                (b"xoxr-", 10, 2),
            ];
            for (prefix, minimum, kind) in prefixes {
                if tail.starts_with(prefix) {
                    let n = run(tail, prefix.len(), |c| {
                        c.is_ascii_alphanumeric()
                            || kind == 1 && (c == b'_' || c == b'-')
                            || kind == 2 && c == b'-'
                            || kind == 3 && c == b'_'
                    });
                    if n >= minimum {
                        consumed = prefix.len() + n;
                        break;
                    }
                }
            }
            if tail.starts_with(b"AKIA")
                && tail.len() >= 20
                && tail[4..20]
                    .iter()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
                && (tail.len() == 20 || !word(tail[20]))
            {
                consumed = 20;
            }
            if tail.starts_with(b"AIza")
                && run(tail, 4, |c| {
                    c.is_ascii_alphanumeric() || c == b'_' || c == b'-'
                }) >= 35
            {
                consumed = 39;
            }
        }
        if pass == 2 && boundary(input, i) {
            if tail.starts_with(b"eyJ") {
                let a = run(tail, 3, |c| {
                    c.is_ascii_alphanumeric() || c == b'_' || c == b'-'
                });
                let p = 3 + a;
                if a >= 5 && tail.get(p) == Some(&b'.') {
                    let b = run(tail, p + 1, |c| {
                        c.is_ascii_alphanumeric() || c == b'_' || c == b'-'
                    });
                    let q = p + 1 + b;
                    if b >= 5 && tail.get(q) == Some(&b'.') {
                        consumed = q
                            + 1
                            + run(tail, q + 1, |c| {
                                c.is_ascii_alphanumeric() || c == b'_' || c == b'-'
                            });
                    }
                }
            }
        }
        if pass == 6 && (i == 0 || !(word(input[i - 1]) || input[i - 1] == b'-')) {
            let n = run(input, i, |c| c.is_ascii_hexdigit());
            if n >= 32 && (i + n == input.len() || !(word(input[i + n]) || input[i + n] == b'-')) {
                consumed = n;
            }
        }
        if pass == 7 && (i == 0 || !(word(input[i - 1]) || b"+=-".contains(&input[i - 1]))) {
            let n = run(input, i, |c| word(c) || b"+=-".contains(&c));
            let part = &input[i..i + n];
            if n >= 32
                && part.iter().any(u8::is_ascii_lowercase)
                && part.iter().any(u8::is_ascii_uppercase)
                && part.iter().any(u8::is_ascii_digit)
            {
                consumed = n;
            }
        }
        if pass == 5 && boundary(input, i) && word(input[i]) {
            let n = run(input, i, |c| word(c) || c == b'.' || c == b'-');
            let field = String::from_utf8_lossy(&input[i..i + n]);
            let mut p = i + n;
            if input.get(p) == Some(&b'\\') {
                p += 1;
            }
            if matches!(input.get(p), Some(b'\'' | b'"')) {
                p += 1;
            }
            while matches!(input.get(p), Some(b' ' | b'\t')) {
                p += 1;
            }
            if secret_field(&field) && matches!(input.get(p), Some(b':' | b'=')) {
                p += 1;
                while matches!(input.get(p), Some(b' ' | b'\t')) {
                    p += 1;
                }
                let start = p;
                let mut valid = false;
                if matches!(input.get(p), Some(b'\'' | b'"')) {
                    let quote = input[p];
                    p += 1;
                    while p < input.len() && input[p] != quote && input[p] != b'\n' {
                        p += 1;
                    }
                    if input.get(p) == Some(&quote) {
                        p += 1;
                        valid = true;
                    }
                }
                if !valid {
                    p = start;
                    if input.get(p) == Some(&b'\\') {
                        p += 1;
                    }
                    if input.get(p) == Some(&b'"') {
                        p += 1;
                    }
                    let content = p;
                    while p < input.len() && !space(input[p]) && !b"\"'\\,;&}".contains(&input[p]) {
                        p += 1;
                    }
                    valid = p > content;
                }
                if valid && !inert(&String::from_utf8_lossy(&input[start..p])) {
                    out.extend_from_slice(&input[i..start]);
                    out.extend_from_slice(b"<secret>");
                    i = p;
                    continue;
                }
            }
        }
        if consumed > 0 {
            out.extend_from_slice(replacement);
            i += consumed;
        } else {
            out.push(input[i]);
            i += 1;
        }
    }
    out
}
fn redact_credentials(input: &[u8]) -> Vec<u8> {
    let mut result = input.to_vec();
    for pass in 0..8 {
        result = redact_pass(&result, pass);
    }
    result
}
fn markers(bytes: &[u8]) -> usize {
    bytes.windows(8).filter(|w| *w == b"<secret>").count()
        + bytes.windows(7).filter(|w| *w == b"<token>").count()
}

pub(crate) fn secret_in(relative: &str, bytes: &[u8], complete: bool) -> bool {
    !complete || secret_name(relative) || markers(&redact_credentials(bytes)) > markers(bytes)
}

pub(crate) fn looks_secret(root: &str, relative: &str) -> bool {
    if secret_name(relative) {
        return true;
    }
    let path = Path::new(root).join(relative);
    let Ok(file) = std::fs::File::open(path) else {
        return true;
    };
    let Ok(meta) = file.metadata() else {
        return true;
    };
    if meta.len() > MAX {
        return true;
    }
    let mut bytes = Vec::new();
    let Ok(_) = file.take(MAX + 1).read_to_end(&mut bytes) else {
        return true;
    };
    secret_in(relative, &bytes, bytes.len() as u64 <= MAX)
}

#[cfg(test)]
#[path = "privacy_tests.rs"]
mod tests;
