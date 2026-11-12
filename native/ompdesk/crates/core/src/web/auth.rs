//! What every request to the web edge passes before it is routed (`web/auth.ts`; design §5.3): the loopback peer, the
//! funnel header, the serve secret as the first path segment, `Host`, `Origin`, `Sec-Fetch-Site`, the Tailscale login
//! against the allowed ones; the device cookie, the one-time tokens (tickets, proof nonces) and a device's P-256 proof.
//! The order of the checks is the contract: the matrix (`matrix.json`) pins it.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;

use hyper::HeaderMap;
use p256::ecdsa::signature::Verifier as _;
use p256::ecdsa::{Signature, VerifyingKey};
use subtle::ConstantTimeEq as _;

use crate::sys;

pub const TICKET_TTL_MS: i64 = 30_000;
pub const COOKIE_MAX_AGE_SECONDS: i64 = 14 * 24 * 60 * 60;

/// What the edge accepts (`RequestPolicy`). `allowed_users` is replaced by `configure` as the settings change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    /// The published name, or `127.0.0.1` before serve is configured.
    pub host: String,
    pub public_port: u16,
    pub secure: bool,
    /// The secret first path segment; `None` until serve is published.
    pub serve_prefix: Option<String>,
    /// The secret this host publishes under before serve's handler is confirmed: a request under it is a 503.
    pub pending_prefix: Option<String>,
    pub allowed_users: Vec<String>,
}

/// A page load, an API call, the WebSocket upgrade, or a webhook call (`RequestKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Page,
    Api,
    Ws,
    Hook,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    UserNotAllowed,
    NoTailscaleUser,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Check {
    /// `target` is the request target with the serve prefix taken off.
    Ok { login: String, target: String },
    Refused {
        status: u16,
        reason: &'static str,
        why: Why,
        login: Option<String>,
    },
}

fn refused(status: u16, reason: &'static str) -> Check {
    Check::Refused {
        status,
        reason,
        why: Why::Other,
        login: None,
    }
}

/// A header's text as Node hands it over: bytes as Latin-1 characters, repeats joined with `, ` (the headers Node
/// keeps only the first of are listed), `cookie` joined with `; `.
pub fn single(headers: &HeaderMap, name: &str) -> Option<String> {
    const FIRST_ONLY: [&str; 18] = [
        "age",
        "authorization",
        "content-length",
        "content-type",
        "etag",
        "expires",
        "from",
        "host",
        "if-modified-since",
        "if-unmodified-since",
        "last-modified",
        "location",
        "max-forwards",
        "proxy-authorization",
        "referer",
        "retry-after",
        "server",
        "user-agent",
    ];
    let mut values = headers
        .get_all(name)
        .iter()
        .map(|v| v.as_bytes().iter().map(|&b| b as char).collect::<String>());
    let first = values.next()?;
    if FIRST_ONLY.contains(&name) {
        return Some(first);
    }
    let joiner = if name == "cookie" { "; " } else { ", " };
    Some(values.fold(first, |acc, next| format!("{acc}{joiner}{next}")))
}

/// `https://host:port` as the browser writes `Origin`.
pub fn origin_of(policy: &Policy) -> String {
    format!(
        "{}://{}",
        if policy.secure { "https" } else { "http" },
        host_header_of(policy)
    )
}

fn host_header_of(policy: &Policy) -> String {
    let standard = if policy.secure { 443 } else { 80 };
    if policy.public_port == standard {
        policy.host.clone()
    } else {
        format!("{}:{}", policy.host, policy.public_port)
    }
}

/// What JavaScript's `\s` and `trim()` count as whitespace.
pub(crate) fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n'
            | '\u{b}'
            | '\u{c}'
            | '\r'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    ) || ('\u{2000}'..='\u{200a}').contains(&c)
}

/// `Buffer.from(text, "base64")` / `"base64url"`: both alphabets, anything else skipped, decoding stops at `=`.
pub fn lenient_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.chars() {
        let v = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => continue,
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// One match of `/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/` starting at `at`: the end and the three groups.
fn mime_word(chars: &[char], at: usize) -> Option<(usize, String, char, String)> {
    if chars.get(at) != Some(&'=') || chars.get(at + 1) != Some(&'?') {
        return None;
    }
    let ordinary = |c: char| c != '?' && !js_space(c);
    let mut i = at + 2;
    let start = i;
    while i < chars.len() && ordinary(chars[i]) {
        i += 1;
    }
    if i == start || chars.get(i) != Some(&'?') {
        return None;
    }
    let charset: String = chars[start..i].iter().collect();
    i += 1;
    let encoding = *chars.get(i)?;
    if !"bBqQ".contains(encoding) || chars.get(i + 1) != Some(&'?') {
        return None;
    }
    i += 2;
    let text_start = i;
    while i < chars.len() && ordinary(chars[i]) {
        i += 1;
    }
    if chars.get(i) != Some(&'?') || chars.get(i + 1) != Some(&'=') {
        return None;
    }
    Some((
        i + 2,
        charset,
        encoding,
        chars[text_start..i].iter().collect(),
    ))
}

/// RFC 2047 encoded words as Tailscale writes a non-ASCII login or name; plain text is returned as it is.
pub fn decode_mime_words(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    // Whitespace between two adjacent encoded words is not content: `(\?=)\s+(?==\?)` -> `$1`.
    let mut joined: Vec<char> = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        joined.push(chars[i]);
        if chars[i] == '?' && chars.get(i + 1) == Some(&'=') {
            joined.push('=');
            let mut j = i + 2;
            while j < chars.len() && js_space(chars[j]) {
                j += 1;
            }
            if j > i + 2 && chars.get(j) == Some(&'=') && chars.get(j + 1) == Some(&'?') {
                i = j;
            } else {
                i += 2;
            }
            continue;
        }
        i += 1;
    }
    let mut out = String::new();
    let mut i = 0;
    while i < joined.len() {
        if let Some((end, charset, encoding, text)) = mime_word(&joined, i) {
            let label = charset.to_lowercase();
            let label = label.split('*').next().unwrap_or("");
            if matches!(label, "utf-8" | "utf8" | "iso-8859-1" | "us-ascii") {
                let bytes: Vec<u8> = if encoding.eq_ignore_ascii_case(&'b') {
                    lenient_base64(&text)
                } else {
                    let raw: Vec<char> = text.replace('_', " ").chars().collect();
                    let mut bytes = Vec::new();
                    let mut k = 0;
                    while k < raw.len() {
                        let hex: String = if raw[k] == '=' {
                            raw[(k + 1).min(raw.len())..(k + 3).min(raw.len())]
                                .iter()
                                .collect()
                        } else {
                            String::new()
                        };
                        if hex.len() == 2 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                            bytes.push(u8::from_str_radix(&hex, 16).unwrap_or(0));
                            k += 3;
                        } else {
                            bytes.push((raw[k] as u32 & 0xff) as u8);
                            k += 1;
                        }
                    }
                    bytes
                };
                if label.starts_with("iso") {
                    out.extend(bytes.iter().map(|&b| b as char));
                } else {
                    // TextDecoder drops a leading byte order mark and replaces what is not UTF-8.
                    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
                    out.push_str(&String::from_utf8_lossy(bytes));
                }
                i = end;
                continue;
            }
            out.extend(&joined[i..end]);
            i = end;
            continue;
        }
        out.push(joined[i]);
        i += 1;
    }
    out
}

/// The login serve put in `Tailscale-User-Login`, decoded; `None` when missing or empty.
pub fn tailscale_login(headers: &HeaderMap) -> Option<String> {
    let raw = single(headers, "tailscale-user-login").filter(|raw| !raw.is_empty())?;
    let decoded = decode_mime_words(&raw);
    let login = decoded.trim_matches(js_space);
    (!login.is_empty()).then(|| login.to_owned())
}

/// `login` is one of `allowed`, trimmed and case-folded (`allowedLogin`).
pub fn allowed_login(allowed: &[String], login: Option<&str>) -> bool {
    let Some(login) = login.filter(|l| !l.is_empty()) else {
        return false;
    };
    let wanted = login.trim_matches(js_space).to_lowercase();
    allowed
        .iter()
        .any(|entry| entry.trim_matches(js_space).to_lowercase() == wanted)
}

/// `target` without the secret first segment, or `None` when it does not start with `/<secret>`; the comparison does
/// not leak how much of the secret matched.
pub fn strip_serve_prefix(target: &str, secret: &str) -> Option<String> {
    let rest_of = target.strip_prefix('/')?;
    let end = rest_of.find(['/', '?', '#']);
    let segment = end.map_or(rest_of, |e| &rest_of[..e]);
    let same =
        segment.len() == secret.len() && bool::from(segment.as_bytes().ct_eq(secret.as_bytes()));
    if !same {
        return None;
    }
    let rest = end.map_or("", |e| &rest_of[e..]);
    Some(if rest.is_empty() {
        "/".to_owned()
    } else if rest.starts_with('/') {
        rest.to_owned()
    } else {
        format!("/{rest}")
    })
}

/// 127.0.0.0/8, ::1 and its IPv4-mapped form.
pub fn is_loopback(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
    }
}

/// Every check for one request, in order (`checkRequest`).
pub fn check_request(
    headers: &HeaderMap,
    method: &str,
    kind: Kind,
    url: &str,
    remote: IpAddr,
    policy: &Policy,
) -> Check {
    if !is_loopback(remote) {
        return refused(403, "not a loopback peer");
    }
    if headers.contains_key("tailscale-funnel-request") {
        return refused(403, "funnel request");
    }
    // Not through serve (or not published yet): a bare 404, and no header on the request is read.
    let Some(prefix) = &policy.serve_prefix else {
        if policy
            .pending_prefix
            .as_deref()
            .is_some_and(|pending| strip_serve_prefix(url, pending).is_some())
        {
            return refused(503, "not published yet");
        }
        return refused(404, "not published");
    };
    let Some(target) = strip_serve_prefix(url, prefix) else {
        return refused(404, "not through serve");
    };

    let expected_host = host_header_of(policy).to_lowercase();
    if single(headers, "host").map(|h| h.to_lowercase()).as_deref() != Some(expected_host.as_str())
    {
        return refused(421, "wrong host");
    }

    let must_carry_origin =
        kind == Kind::Ws || (kind != Kind::Hook && method != "GET" && method != "HEAD");
    let wrong_origin = match single(headers, "origin") {
        None => must_carry_origin,
        Some(origin) => origin.to_lowercase() != origin_of(policy).to_lowercase(),
    };
    if wrong_origin {
        return refused(403, "wrong origin");
    }

    if let Some(site) = single(headers, "sec-fetch-site")
        && site != "same-origin"
        && site != "none"
    {
        // A link from another app opens the page as a cross-site navigation; nothing else may be cross-site.
        let navigation =
            kind == Kind::Page && single(headers, "sec-fetch-mode").as_deref() == Some("navigate");
        if !navigation {
            return refused(403, "cross-site request");
        }
    }

    let Some(login) = tailscale_login(headers) else {
        return Check::Refused {
            status: 403,
            reason: "no tailscale user",
            why: Why::NoTailscaleUser,
            login: None,
        };
    };
    if !allowed_login(&policy.allowed_users, Some(&login)) {
        return Check::Refused {
            status: 403,
            reason: "tailscale user not allowed",
            why: Why::UserNotAllowed,
            login: Some(login),
        };
    }
    Check::Ok { login, target }
}

/// `__Host-` over HTTPS (no sibling can plant or shadow it), a plain name over plain HTTP.
pub fn cookie_name(secure: bool) -> &'static str {
    if secure { "__Host-ompdesk" } else { "ompdesk" }
}

pub fn serialize_device_cookie(value: &str, secure: bool, max_age: i64) -> String {
    format!(
        "{}={value}; Path=/; HttpOnly; SameSite=Strict{}; Max-Age={max_age}",
        cookie_name(secure),
        if secure { "; Secure" } else { "" }
    )
}

pub fn cleared_device_cookie(secure: bool) -> String {
    serialize_device_cookie("", secure, 0)
}

/// The device cookie's value (`<deviceId>.<secret>`) in a `Cookie` header, or `None`.
pub fn device_cookie_value(headers: &HeaderMap, secure: bool) -> Option<String> {
    let header = single(headers, "cookie").filter(|h| !h.is_empty())?;
    let wanted = cookie_name(secure);
    for part in header.split(';') {
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        if name.trim_matches(js_space) == wanted {
            let value = value.trim_matches(js_space);
            return (!value.is_empty()).then(|| value.to_owned());
        }
    }
    None
}

/// Random single-use tokens that expire: a WebSocket ticket, or the nonce a device signs to prove its key.
pub struct OneTimeTokens<T> {
    ttl_ms: i64,
    live: Mutex<HashMap<String, (T, i64)>>,
}

impl<T> OneTimeTokens<T> {
    pub fn new(ttl_ms: i64) -> Self {
        Self {
            ttl_ms,
            live: Mutex::new(HashMap::new()),
        }
    }

    /// A token for `value` and when it expires.
    pub fn issue(&self, value: T, now: i64) -> (String, i64) {
        let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
        live.retain(|_, (_, expires)| *expires > now);
        let mut bytes = [0u8; 24];
        // The generator failing leaves no safe token: stop the request rather than hand out a guessable one.
        sys::random(&mut bytes).expect("the system's random generator");
        let token = base64url(&bytes);
        let expires = now + self.ttl_ms;
        live.insert(token.clone(), (value, expires));
        (token, expires)
    }

    /// The value a token was issued for; the token is spent whether or not it was still valid.
    pub fn redeem(&self, token: &str, now: i64) -> Option<T> {
        let (value, expires) = self
            .live
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(token)?;
        (expires > now).then_some(value)
    }
}

pub fn base64url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// The public half of a device's WebCrypto ECDSA P-256 key as `/api/pair` accepts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicKey {
    pub x: String,
    pub y: String,
}

fn is_coordinate(text: &str) -> bool {
    text.len() == 43
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `parsePublicKeyJwk`: `kty` EC, `crv` P-256, no private part, `x` and `y` 43 base64url characters.
pub fn parse_public_key_jwk(value: &serde_json::Value) -> Option<PublicKey> {
    let object = value.as_object()?;
    if object.get("kty")?.as_str()? != "EC"
        || object.get("crv")?.as_str()? != "P-256"
        || object.contains_key("d")
    {
        return None;
    }
    let (x, y) = (object.get("x")?.as_str()?, object.get("y")?.as_str()?);
    (is_coordinate(x) && is_coordinate(y)).then(|| PublicKey {
        x: x.to_owned(),
        y: y.to_owned(),
    })
}

/// Whether `signature` (base64url, IEEE P1363: `r` then `s`, 32 bytes each, as WebCrypto writes it) signs `nonce`'s
/// UTF-8 bytes under SHA-256 with the device's key. A signature that is not exactly 64 bytes, a DER one, or a key not
/// on the curve is simply false.
pub fn verify_device_proof(key: &PublicKey, nonce: &str, signature: &str) -> bool {
    let (x, y) = (lenient_base64(&key.x), lenient_base64(&key.y));
    if x.len() != 32 || y.len() != 32 {
        return false;
    }
    let mut point = Vec::with_capacity(65);
    point.push(0x04);
    point.extend_from_slice(&x);
    point.extend_from_slice(&y);
    let Ok(verifying) = VerifyingKey::from_sec1_bytes(&point) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(&lenient_base64(signature)) else {
        return false;
    };
    verifying.verify(nonce.as_bytes(), &signature).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderValue;

    const HOST: &str = "mac.tail1234.ts.net";
    const SECRET: &str = "s3cr3tPrefixValue_0123456789abcdefghijklmnop";

    fn policy() -> Policy {
        Policy {
            host: HOST.into(),
            public_port: 47831,
            secure: true,
            serve_prefix: Some(SECRET.into()),
            pending_prefix: None,
            allowed_users: vec!["me@example.com".into()],
        }
    }

    fn good() -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            "host",
            HeaderValue::from_str(&format!("{HOST}:47831")).unwrap(),
        );
        h.insert(
            "origin",
            HeaderValue::from_str(&format!("https://{HOST}:47831")).unwrap(),
        );
        h.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
        h.insert(
            "tailscale-user-login",
            HeaderValue::from_static("me@example.com"),
        );
        h
    }

    fn check(h: &HeaderMap, method: &str, kind: Kind, url: &str, p: &Policy) -> Check {
        check_request(h, method, kind, url, "127.0.0.1".parse().unwrap(), p)
    }

    #[test]
    fn passes_a_request_through_serve() {
        let url = format!("/{SECRET}/ws?x=1");
        assert_eq!(
            check(&good(), "GET", Kind::Ws, &url, &policy()),
            Check::Ok {
                login: "me@example.com".into(),
                target: "/ws?x=1".into()
            }
        );
    }

    #[test]
    fn walls_answer_in_order() {
        let p = policy();
        let url = format!("/{SECRET}/x");
        let status = |c: Check| match c {
            Check::Refused { status, .. } => status,
            Check::Ok { .. } => 200,
        };
        let remote_other: IpAddr = "100.64.0.1".parse().unwrap();
        assert_eq!(
            status(check_request(
                &good(),
                "GET",
                Kind::Page,
                &url,
                remote_other,
                &p
            )),
            403
        );
        let mut h = good();
        h.insert("tailscale-funnel-request", HeaderValue::from_static("?1"));
        assert_eq!(
            status(check(&h, "GET", Kind::Page, "/other", &p)),
            403,
            "funnel before the prefix"
        );
        // No serve prefix configured: a 404 that reads no header, a 503 under the pending secret.
        let mut unpublished = p.clone();
        unpublished.serve_prefix = None;
        assert_eq!(
            status(check(
                &HeaderMap::new(),
                "GET",
                Kind::Page,
                &url,
                &unpublished
            )),
            404
        );
        unpublished.pending_prefix = Some(SECRET.into());
        assert_eq!(
            status(check(
                &HeaderMap::new(),
                "GET",
                Kind::Page,
                &url,
                &unpublished
            )),
            503
        );
        assert_eq!(
            status(check(
                &HeaderMap::new(),
                "GET",
                Kind::Page,
                "/other",
                &unpublished
            )),
            404
        );
        assert_eq!(status(check(&good(), "GET", Kind::Page, "/other", &p)), 404);
        let mut h = good();
        h.insert("host", HeaderValue::from_static("evil.example"));
        h.insert("origin", HeaderValue::from_static("https://evil.example"));
        assert_eq!(
            status(check(&h, "GET", Kind::Page, &url, &p)),
            421,
            "host before origin"
        );
        let mut h = good();
        h.remove("origin");
        assert_eq!(status(check(&h, "GET", Kind::Page, &url, &p)), 200);
        assert_eq!(status(check(&h, "POST", Kind::Api, &url, &p)), 403);
        assert_eq!(
            status(check(&h, "POST", Kind::Hook, &url, &p)),
            200,
            "a webhook needs no origin"
        );
        assert_eq!(status(check(&h, "GET", Kind::Ws, &url, &p)), 403);
        let mut h = good();
        h.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
        assert_eq!(status(check(&h, "GET", Kind::Api, &url, &p)), 403);
        assert_eq!(status(check(&h, "GET", Kind::Page, &url, &p)), 403);
        h.insert("sec-fetch-mode", HeaderValue::from_static("navigate"));
        assert_eq!(status(check(&h, "GET", Kind::Page, &url, &p)), 200);
        assert_eq!(status(check(&h, "GET", Kind::Api, &url, &p)), 403);
        let mut h = good();
        h.remove("tailscale-user-login");
        assert!(matches!(
            check(&h, "GET", Kind::Page, &url, &p),
            Check::Refused {
                why: Why::NoTailscaleUser,
                ..
            }
        ));
        h.insert(
            "tailscale-user-login",
            HeaderValue::from_static("other@example.com"),
        );
        assert!(matches!(
            check(&h, "GET", Kind::Page, &url, &p),
            Check::Refused {
                why: Why::UserNotAllowed,
                login: Some(_),
                ..
            }
        ));
    }

    #[test]
    fn serve_prefix_is_taken_off_exactly() {
        assert_eq!(
            strip_serve_prefix(&format!("/{SECRET}"), SECRET).as_deref(),
            Some("/")
        );
        assert_eq!(
            strip_serve_prefix(&format!("/{SECRET}/a/b?x=1"), SECRET).as_deref(),
            Some("/a/b?x=1")
        );
        assert_eq!(
            strip_serve_prefix(&format!("/{SECRET}?x=1"), SECRET).as_deref(),
            Some("/?x=1")
        );
        assert_eq!(strip_serve_prefix(&format!("/{SECRET}x/a"), SECRET), None);
        assert_eq!(
            strip_serve_prefix(&format!("/{}/a", &SECRET[1..]), SECRET),
            None
        );
        assert_eq!(strip_serve_prefix("a", SECRET), None);
    }

    #[test]
    fn mime_words_decode_as_the_script_did() {
        assert_eq!(decode_mime_words("plain@example.com"), "plain@example.com");
        assert_eq!(
            decode_mime_words("=?utf-8?q?me=40example.com?="),
            "me@example.com"
        );
        assert_eq!(decode_mime_words("=?UTF-8?B?7ZmN6ri464+Z?="), "홍길동");
        assert_eq!(decode_mime_words("=?utf-8?q?a?= =?utf-8?q?b?="), "ab");
        assert_eq!(decode_mime_words("=?iso-8859-1?q?caf=E9?="), "café");
        assert_eq!(decode_mime_words("=?utf-8?q?a_b?="), "a b");
        assert_eq!(decode_mime_words("=?koi8-r?q?x?="), "=?koi8-r?q?x?=");
        assert_eq!(decode_mime_words("=?utf-8?q?bad=ZZ?="), "bad=ZZ");
    }

    #[test]
    fn login_header_is_decoded_and_trimmed() {
        let mut h = HeaderMap::new();
        assert_eq!(tailscale_login(&h), None);
        h.insert("tailscale-user-login", HeaderValue::from_static("   "));
        assert_eq!(tailscale_login(&h), None);
        h.insert(
            "tailscale-user-login",
            HeaderValue::from_static(" =?utf-8?q?me=40example.com?= "),
        );
        assert_eq!(tailscale_login(&h).as_deref(), Some("me@example.com"));
        assert!(allowed_login(
            &["ME@Example.com ".into()],
            Some("me@example.COM")
        ));
        assert!(!allowed_login(&["me@example.com".into()], None));
    }

    #[test]
    fn cookie_is_named_and_read_by_scheme() {
        assert_eq!(
            serialize_device_cookie("a.b", true, COOKIE_MAX_AGE_SECONDS),
            "__Host-ompdesk=a.b; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=1209600"
        );
        assert_eq!(
            serialize_device_cookie("a.b", false, 5),
            "ompdesk=a.b; Path=/; HttpOnly; SameSite=Strict; Max-Age=5"
        );
        assert_eq!(
            cleared_device_cookie(true),
            "__Host-ompdesk=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0"
        );
        let mut h = HeaderMap::new();
        h.insert(
            "cookie",
            HeaderValue::from_static("x=1; __Host-ompdesk=dev.sec; y=2"),
        );
        assert_eq!(device_cookie_value(&h, true).as_deref(), Some("dev.sec"));
        assert_eq!(device_cookie_value(&h, false), None);
        h.insert("cookie", HeaderValue::from_static("__Host-ompdesk="));
        assert_eq!(device_cookie_value(&h, true), None);
    }

    #[test]
    fn tokens_are_single_use_and_expire() {
        let tokens = OneTimeTokens::new(TICKET_TTL_MS);
        let (token, expires) = tokens.issue("dev", 1_000);
        assert_eq!(expires, 31_000);
        assert_eq!(tokens.redeem(&token, 2_000), Some("dev"));
        assert_eq!(tokens.redeem(&token, 2_000), None);
        let (late, _) = tokens.issue("dev", 1_000);
        assert_eq!(
            tokens.redeem(&late, 31_000),
            None,
            "expired exactly at its time"
        );
        assert_eq!(
            tokens.redeem(&late, 2_000),
            None,
            "spent by the failed redeem"
        );
    }

    #[test]
    fn jwk_is_accepted_only_as_a_public_p256_key() {
        let x = "A".repeat(43);
        let ok = serde_json::json!({"kty": "EC", "crv": "P-256", "x": x, "y": x, "ext": true});
        assert_eq!(
            parse_public_key_jwk(&ok),
            Some(PublicKey {
                x: x.clone(),
                y: x.clone()
            })
        );
        for bad in [
            serde_json::json!({"kty": "EC", "crv": "P-256", "x": x, "y": x, "d": x}),
            serde_json::json!({"kty": "RSA", "crv": "P-256", "x": x, "y": x}),
            serde_json::json!({"kty": "EC", "crv": "P-384", "x": x, "y": x}),
            serde_json::json!({"kty": "EC", "crv": "P-256", "x": "short", "y": x}),
            serde_json::json!("string"),
        ] {
            assert_eq!(parse_public_key_jwk(&bad), None);
        }
    }
}
