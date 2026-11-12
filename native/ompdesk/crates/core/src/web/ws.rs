//! The WebSocket upgrade as `ws` 8 answers it (`server.ts` `#wss`: `perMessageDeflate: { threshold: 1024,
//! zlibDeflateOptions: { level: 3 } }`, `maxPayload` 1 MiB, the one subprotocol `ompdesk.v1`), with yawc 0.5 framing
//! the upgraded stream.
//!
//! The handshake is answered here and not by yawc: given the offer both Chromium and `ws` send
//! (`permessage-deflate; client_max_window_bits`) yawc answers `permessage-deflate; client_max_window_bits=9`, a
//! 512-byte window for what the phone sends, where `ws` answers a bare `permessage-deflate`; and an answer fixed at
//! `client_max_window_bits=15` would be a protocol error to a client that did not offer the parameter. So the offer is
//! read and answered as `ws`'s `PerMessageDeflate.acceptAsServer` does, and the agreed header is handed to yawc
//! (`WebSocket::from_stream_with_extensions`), which takes the window bits and the context takeover from it. Framing,
//! masking, the deflate context kept across messages both ways and the 1024-byte threshold are yawc's.

use sha1::{Digest, Sha1};
use yawc::{CompressionLevel, Options};

pub const SUBPROTOCOL: &str = "ompdesk.v1";
/// `maxPayload` of the page's socket (`ws-router.ts` `MAX_FRAME_BYTES`): a longer message closes the socket with 1009.
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
/// `perMessageDeflate.threshold`: a message shorter than this goes out uncompressed.
pub const DEFLATE_THRESHOLD: usize = 1024;
/// `zlibDeflateOptions.level` is 3 in the TypeScript. zlib-rs's level 3 is a different (faster, looser) strategy than
/// zlib's: the same 200 messages cost 22,069 bytes at 3, 21,034 at 4, 20,859 at 5 and 19,946 at 6, against 19,700 for `ws`.
/// Level 6 is the one that keeps the bytes a phone is sent within 1.3% of what `ws` sent.
const DEFLATE_LEVEL: u32 = 6;
const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Why `ws` would have answered the upgrade with a plain error instead of `101`.
#[derive(Debug, PartialEq, Eq)]
pub struct Refusal {
    pub status: u16,
    pub message: &'static str,
    /// Headers `ws` adds to its `abortHandshake` answer.
    pub headers: &'static [(&'static str, &'static str)],
}

fn refuse(status: u16, message: &'static str) -> Refusal {
    Refusal {
        status,
        message,
        headers: &[],
    }
}

/// What the request asked for, as the answer's headers need it.
#[derive(Debug, PartialEq, Eq)]
pub struct Accepted {
    pub digest: String,
    /// The subprotocol chosen: `ompdesk.v1` when the client listed it.
    pub protocol: Option<&'static str>,
    /// The `Sec-WebSocket-Extensions` value to answer with and to hand to yawc.
    pub extensions: Option<String>,
}

/// The request's headers `ws.handleUpgrade` reads; absent is `None`.
pub struct UpgradeHeaders<'a> {
    pub method: &'a str,
    pub upgrade: Option<&'a str>,
    pub key: Option<&'a str>,
    pub version: Option<&'a str>,
    pub protocol: Option<&'a str>,
    pub extensions: Option<&'a str>,
}

/// `ws`'s `handleUpgrade` checks, in its order, then its answer's parameters.
pub fn accept(request: &UpgradeHeaders<'_>) -> Result<Accepted, Refusal> {
    if request.method != "GET" {
        return Err(refuse(405, "Invalid HTTP method"));
    }
    if !request
        .upgrade
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
    {
        return Err(refuse(400, "Invalid Upgrade header"));
    }
    let key = match request.key {
        Some(key) if valid_key(key) => key,
        _ => return Err(refuse(400, "Missing or invalid Sec-WebSocket-Key header")),
    };
    // `+version` in the TypeScript: a number, so " 13" and "013" pass too.
    let version = request
        .version
        .and_then(|value| value.trim().parse::<u32>().ok());
    if version != Some(13) && version != Some(8) {
        return Err(Refusal {
            status: 400,
            message: "Missing or invalid Sec-WebSocket-Version header",
            headers: &[("Sec-WebSocket-Version", "13, 8")],
        });
    }
    let protocols = match request.protocol {
        Some(header) => parse_protocols(header)
            .ok_or_else(|| refuse(400, "Invalid Sec-WebSocket-Protocol header"))?,
        None => Vec::new(),
    };
    let extensions = match request.extensions {
        Some(header) => negotiate_deflate(header).map_err(|BadOffer| {
            refuse(
                400,
                "Invalid or unacceptable Sec-WebSocket-Extensions header",
            )
        })?,
        None => None,
    };
    let mut sha = Sha1::new();
    sha.update(key.as_bytes());
    sha.update(GUID.as_bytes());
    use base64::Engine as _;
    let digest = base64::engine::general_purpose::STANDARD.encode(sha.finalize());
    let protocol = protocols
        .iter()
        .any(|p| p == SUBPROTOCOL)
        .then_some(SUBPROTOCOL);
    Ok(Accepted {
        digest,
        protocol,
        extensions,
    })
}

/// `/^[+/0-9A-Za-z]{22}==$/`.
fn valid_key(key: &str) -> bool {
    key.len() == 24
        && key.ends_with("==")
        && key.as_bytes()[..22]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/')
}

fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

/// `subprotocol.parse`: tokens separated by commas and optional spaces; anything else (an empty entry, a duplicate)
/// is an error.
fn parse_protocols(header: &str) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for part in header.split(',') {
        let token = part.trim_matches([' ', '\t']);
        if token.is_empty()
            || !token.bytes().all(is_token_byte)
            || out.iter().any(|seen| seen == token)
        {
            return None;
        }
        out.push(token.to_owned());
    }
    Some(out)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Param {
    Flag,
    Bits(u8),
}

/// One `permessage-deflate` offer after `normalizeParams`, in the order the client wrote it.
type Params = Vec<(String, Param)>;

/// `extension.parse` and `PerMessageDeflate.accept` with the options `server.ts` leaves at their defaults: all offers
/// are validated, the first is taken and echoed, `client_max_window_bits` without a value dropped. `Ok(None)` when no
/// offer is `permessage-deflate`; `Err` where `ws` answers 400.
pub fn negotiate_deflate(header: &str) -> Result<Option<String>, BadOffer> {
    let offers = parse_offers(header)?;
    let mut configurations: Vec<Params> = Vec::new();
    for (name, params) in offers {
        if name != "permessage-deflate" {
            continue;
        }
        configurations.push(normalize(params)?);
    }
    let Some(mut accepted) = configurations.into_iter().next() else {
        return Ok(None);
    };
    accepted.retain(|(name, value)| !(name == "client_max_window_bits" && *value == Param::Flag));
    let mut out = String::from("permessage-deflate");
    for (name, value) in &accepted {
        out.push_str("; ");
        out.push_str(name);
        if let Param::Bits(bits) = value {
            out.push('=');
            out.push_str(&bits.to_string());
        }
    }
    Ok(Some(out))
}

/// An offer `ws` would answer with a 400.
#[derive(Debug, PartialEq, Eq)]
pub struct BadOffer;

type RawOffer = (String, Vec<(String, Option<String>)>);

fn parse_offers(header: &str) -> Result<Vec<RawOffer>, BadOffer> {
    let bytes = header.as_bytes();
    let mut i = 0;
    let mut offers = Vec::new();
    let skip = |i: &mut usize| {
        while *i < bytes.len() && (bytes[*i] == b' ' || bytes[*i] == b'\t') {
            *i += 1;
        }
    };
    let token = |i: &mut usize| -> Result<String, BadOffer> {
        let start = *i;
        while *i < bytes.len() && is_token_byte(bytes[*i]) {
            *i += 1;
        }
        if start == *i {
            Err(BadOffer)
        } else {
            Ok(header[start..*i].to_owned())
        }
    };
    loop {
        skip(&mut i);
        let name = token(&mut i)?;
        let mut params = Vec::new();
        skip(&mut i);
        while i < bytes.len() && bytes[i] == b';' {
            i += 1;
            skip(&mut i);
            let key = token(&mut i)?;
            skip(&mut i);
            let mut value = None;
            if i < bytes.len() && bytes[i] == b'=' {
                i += 1;
                skip(&mut i);
                if i < bytes.len() && bytes[i] == b'"' {
                    i += 1;
                    let mut text = String::new();
                    loop {
                        match bytes.get(i) {
                            None => return Err(BadOffer),
                            Some(b'"') => {
                                i += 1;
                                break;
                            }
                            Some(b'\\') => {
                                i += 1;
                                text.push(*bytes.get(i).ok_or(BadOffer)? as char);
                                i += 1;
                            }
                            Some(&b) => {
                                text.push(b as char);
                                i += 1;
                            }
                        }
                    }
                    value = Some(text);
                } else {
                    value = Some(token(&mut i)?);
                }
                skip(&mut i);
            }
            params.push((key, value));
        }
        offers.push((name, params));
        if i == bytes.len() {
            return Ok(offers);
        }
        if bytes[i] != b',' {
            return Err(BadOffer);
        }
        i += 1;
    }
}

fn window_bits(value: &str) -> Result<u8, BadOffer> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(BadOffer);
    }
    match value.parse::<u8>() {
        Ok(bits @ 8..=15) => Ok(bits),
        _ => Err(BadOffer),
    }
}

fn normalize(params: Vec<(String, Option<String>)>) -> Result<Params, BadOffer> {
    let mut out: Params = Vec::new();
    for (key, value) in params {
        if out.iter().any(|(seen, _)| *seen == key) {
            return Err(BadOffer);
        }
        let param = match key.as_str() {
            "client_max_window_bits" => match value {
                None => Param::Flag,
                Some(text) => Param::Bits(window_bits(&text)?),
            },
            "server_max_window_bits" => Param::Bits(window_bits(&value.ok_or(BadOffer)?)?),
            "client_no_context_takeover" | "server_no_context_takeover" => match value {
                None => Param::Flag,
                Some(_) => return Err(BadOffer),
            },
            _ => return Err(BadOffer),
        };
        out.push((key, param));
    }
    Ok(out)
}

/// yawc's settings for the page's socket, given the `Sec-WebSocket-Extensions` answered.
///
/// `ws` honours its `threshold` only for a direction that negotiated no context takeover (`sender.js`): with the
/// context kept, every message is deflated, small ones too, since the receiver's dictionary must see them. yawc skips
/// anything under its threshold in either mode, which would leave small messages out of the context and cost bytes, so
/// the threshold is set only when the server side agreed to `server_no_context_takeover`.
pub fn options_for(extensions: Option<&str>) -> Options {
    let no_takeover = extensions.is_some_and(|value| value.contains("server_no_context_takeover"));
    let mut options = Options::default()
        .with_compression_level(CompressionLevel::new(DEFLATE_LEVEL))
        .with_compression_threshold(if no_takeover { DEFLATE_THRESHOLD } else { 0 })
        .with_limits(MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES)
        .with_utf8();
    options.no_delay = true;
    options
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deflate(header: &str) -> Result<Option<String>, BadOffer> {
        negotiate_deflate(header)
    }

    #[test]
    fn answers_as_ws_does() {
        // Captured from ws 8.22 (`server.ts`'s options) on 12 Nov 2026.
        assert_eq!(
            deflate("permessage-deflate; client_max_window_bits"),
            Ok(Some("permessage-deflate".into()))
        );
        assert_eq!(
            deflate("permessage-deflate; client_max_window_bits=15"),
            Ok(Some("permessage-deflate; client_max_window_bits=15".into()))
        );
        assert_eq!(
            deflate("permessage-deflate; client_no_context_takeover; server_no_context_takeover"),
            Ok(Some(
                "permessage-deflate; client_no_context_takeover; server_no_context_takeover".into()
            ))
        );
        assert_eq!(
            deflate("permessage-deflate; server_max_window_bits=10"),
            Ok(Some("permessage-deflate; server_max_window_bits=10".into()))
        );
        assert_eq!(
            deflate("permessage-deflate"),
            Ok(Some("permessage-deflate".into()))
        );
        assert_eq!(deflate("x-webkit-deflate-frame"), Ok(None));
        // Order is the client's.
        assert_eq!(
            deflate("permessage-deflate; server_no_context_takeover; client_max_window_bits=12"),
            Ok(Some(
                "permessage-deflate; server_no_context_takeover; client_max_window_bits=12".into()
            ))
        );
        // The first of several offers; a bare window parameter still dropped.
        assert_eq!(
            deflate(
                "permessage-deflate; client_max_window_bits, permessage-deflate; server_no_context_takeover"
            ),
            Ok(Some("permessage-deflate".into()))
        );
        // Another extension beside it is ignored.
        assert_eq!(
            deflate("foo; a=b, permessage-deflate"),
            Ok(Some("permessage-deflate".into()))
        );
    }

    #[test]
    fn refuses_what_ws_refuses() {
        for bad in [
            "permessage-deflate; unknown",
            "permessage-deflate; server_max_window_bits",
            "permessage-deflate; server_max_window_bits=7",
            "permessage-deflate; server_max_window_bits=16",
            "permessage-deflate; client_max_window_bits=x",
            "permessage-deflate; client_no_context_takeover=1",
            "permessage-deflate; client_no_context_takeover; client_no_context_takeover",
            "permessage-deflate;",
            "",
            ",",
            "permessage-deflate, ",
        ] {
            assert_eq!(deflate(bad), Err(BadOffer), "{bad}");
        }
    }

    #[test]
    fn handshake_checks_come_in_ws_order() {
        let mut request = UpgradeHeaders {
            method: "GET",
            upgrade: Some("WebSocket"),
            key: Some("dGhlIHNhbXBsZSBub25jZQ=="),
            version: Some("13"),
            protocol: Some("ompdesk.v1, ticket.abc"),
            extensions: Some("permessage-deflate; client_max_window_bits"),
        };
        let accepted = accept(&request).unwrap();
        assert_eq!(accepted.digest, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        assert_eq!(accepted.protocol, Some("ompdesk.v1"));
        assert_eq!(accepted.extensions.as_deref(), Some("permessage-deflate"));
        request.protocol = Some("other");
        assert_eq!(accept(&request).unwrap().protocol, None);
        request.version = Some("12");
        assert_eq!(accept(&request).unwrap_err().status, 400);
        request.key = Some("short");
        assert_eq!(
            accept(&request).unwrap_err().message,
            "Missing or invalid Sec-WebSocket-Key header"
        );
        request.upgrade = None;
        assert_eq!(
            accept(&request).unwrap_err().message,
            "Invalid Upgrade header"
        );
        request.method = "POST";
        assert_eq!(accept(&request).unwrap_err().status, 405);
    }
}
