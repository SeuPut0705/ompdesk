//! NDJSON framing and v2 chunk reassembly of an omp's stdout (was `src/main/rpc-bridge.ts`), and the text helpers of its
//! stderr (`stripVTControlCharacters`, JavaScript's `trim`).
//!
//! A line is one JSON object. A frame whose `type` is `rpc_chunk` is one piece of a bigger frame (protocol v2): the
//! server writes the pieces of one frame contiguously, so a sequence is rejected as a whole when anything else comes
//! between its pieces, and only one frame's pieces are ever held. A frame is passed on as the bytes omp wrote.

use std::borrow::Cow;

use serde::Deserialize;
use serde::de::{self, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::Value;

pub const RPC_MAX_FRAME_BYTES: u64 = 1_048_576;
pub const RPC_MAX_REASSEMBLED_BYTES: u64 = 67_108_864;
const CHUNK_PAYLOAD_BYTES: usize = 262_144;
const MAX_CHUNK_COUNT: u64 = RPC_MAX_REASSEMBLED_BYTES.div_ceil(CHUNK_PAYLOAD_BYTES as u64);
/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// Negotiate v2 only when both peers agree on the framing limits.
pub fn supports_v2(ready: &Value) -> bool {
    let Some(ready) = ready.as_object() else {
        return false;
    };
    ready
        .get("supportedProtocolVersions")
        .and_then(Value::as_array)
        .is_some_and(|versions| versions.iter().any(|v| v.as_f64() == Some(2.0)))
        && ready.get("maxFrameBytes").and_then(Value::as_f64) == Some(RPC_MAX_FRAME_BYTES as f64)
        && ready
            .get("maxReassembledFrameBytes")
            .and_then(Value::as_f64)
            == Some(RPC_MAX_REASSEMBLED_BYTES as f64)
}

/// A string field of a frame, whatever else the field may hold: `None` for anything that is not a string.
#[derive(Default)]
struct Text(Option<String>);

impl<'de> Deserialize<'de> for Text {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> Result<Text, D::Error> {
        struct Reader;
        impl<'de> Visitor<'de> for Reader {
            type Value = Text;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Text, E> {
                Ok(Text(Some(v.to_owned())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Text, E> {
                Ok(Text(Some(v)))
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Text, E> {
                Ok(Text(None))
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Text, E> {
                Ok(Text(None))
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Text, E> {
                Ok(Text(None))
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Text, E> {
                Ok(Text(None))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Text, E> {
                Ok(Text(None))
            }
            fn visit_none<E: de::Error>(self) -> Result<Text, E> {
                Ok(Text(None))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Text, A::Error> {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Text(None))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Text, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Text(None))
            }
        }
        deserializer.deserialize_any(Reader)
    }
}

/// The two fields of a frame the lane routes by.
#[derive(Deserialize, Default)]
struct Head {
    #[serde(rename = "type", default)]
    ty: Text,
    #[serde(default)]
    id: Text,
}

/// `(type, id)` of a JSON object's text, each only when it is a string; `None` when the text is no object.
pub fn head_of(json: &str) -> Option<(Option<String>, Option<String>)> {
    // A struct also reads from a JSON array's elements: only an object is a frame.
    if !json.trim_start().starts_with('{') {
        return None;
    }
    match serde_json::from_str::<Head>(json) {
        Ok(head) => Some((head.ty.0, head.id.0)),
        // A key written twice is an error for the derive, where `JSON.parse` keeps the last.
        Err(_) => match serde_json::from_str::<Value>(json).ok()? {
            Value::Object(map) => Some((
                map.get("type").and_then(Value::as_str).map(str::to_owned),
                map.get("id").and_then(Value::as_str).map(str::to_owned),
            )),
            _ => None,
        },
    }
}

/// One frame of omp's, as the bytes it wrote (trimmed) and what the lane routes it by.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub raw: Vec<u8>,
    pub ty: Option<String>,
}

impl Frame {
    /// A frame from its JSON text, when that is an object.
    pub fn from_json(json: &str) -> Option<Frame> {
        let (ty, _) = head_of(json)?;
        Some(Frame {
            raw: json.as_bytes().to_vec(),
            ty,
        })
    }

    pub fn text(&self) -> Cow<'_, str> {
        String::from_utf8_lossy(&self.raw)
    }
}

/// JavaScript's `String.prototype.trim`: its whitespace set, which is not Unicode's `White_Space`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| {
        matches!(
            c,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    })
}

/// Strict base64 (`decodeBase64`): standard alphabet, padded, and the canonical spelling of its bytes.
fn decode_base64(data: &str) -> Result<Vec<u8>, &'static str> {
    const BAD: &str = "Invalid RPC chunk data";
    let bytes = data.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return Err(BAD);
    }
    let value = |b: u8| -> Option<u32> {
        match b {
            b'A'..=b'Z' => Some(u32::from(b - b'A')),
            b'a'..=b'z' => Some(u32::from(b - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(b - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let quads = bytes.len() / 4;
    for (index, quad) in bytes.chunks(4).enumerate() {
        let last = index + 1 == quads;
        let padding = if last {
            quad.iter().rev().take_while(|&&b| b == b'=').count()
        } else {
            0
        };
        if padding > 2 {
            return Err(BAD);
        }
        let mut acc = 0u32;
        for (at, &b) in quad.iter().enumerate() {
            let v = if at >= 4 - padding {
                0
            } else {
                value(b).ok_or(BAD)?
            };
            acc = acc << 6 | v;
        }
        // The bits a padded tail leaves unused must be zero: that is the one spelling `toString("base64")` writes.
        match padding {
            0 => {}
            1 if acc & 0xff != 0 => return Err(BAD),
            2 if acc & 0xffff != 0 => return Err(BAD),
            _ => {}
        }
        let triple = [(acc >> 16) as u8, (acc >> 8) as u8, acc as u8];
        out.extend_from_slice(&triple[..3 - padding]);
    }
    Ok(out)
}

struct Pending {
    chunk_id: String,
    count: u64,
    byte_length: u64,
    next_index: u64,
    received: u64,
    bytes: Vec<u8>,
}

/// Reassembles one v2 chunk sequence. The server writes a sequence contiguously; rejecting interleaving keeps the
/// retained memory bounded to one logical frame.
#[derive(Default)]
pub struct ChunkReassembler {
    pending: Option<Pending>,
}

fn safe_integer(value: Option<&Value>) -> Option<u64> {
    let number = value?.as_f64()?;
    if number.fract() != 0.0 || number.abs() > MAX_SAFE {
        return None;
    }
    // Negative integers are safe integers too: the caller's range check refuses them.
    Some(if number < 0.0 {
        u64::MAX
    } else {
        number as u64
    })
}

impl ChunkReassembler {
    #[cfg(test)]
    pub fn pending(&self) -> bool {
        self.pending.is_some()
    }

    pub fn clear(&mut self) {
        self.pending = None;
    }

    /// One `rpc_chunk` frame; the whole frame's bytes once its last piece came.
    pub fn feed(&mut self, frame: &Value) -> Result<Option<Vec<u8>>, &'static str> {
        let outcome = self.feed_inner(frame);
        if outcome.is_err() {
            self.pending = None;
        }
        outcome
    }

    fn feed_inner(&mut self, frame: &Value) -> Result<Option<Vec<u8>>, &'static str> {
        let chunk_id = frame.get("chunkId").and_then(Value::as_str);
        let index = safe_integer(frame.get("index"));
        let count = safe_integer(frame.get("count"));
        let byte_length = safe_integer(frame.get("byteLength"));
        let (Some(chunk_id), Some(index), Some(count), Some(byte_length)) =
            (chunk_id, index, count, byte_length)
        else {
            return Err("Invalid RPC chunk metadata");
        };
        let id_units = chunk_id.encode_utf16().count();
        if id_units == 0
            || id_units > 128
            || index == u64::MAX
            || !(2..=MAX_CHUNK_COUNT).contains(&count)
            || !(RPC_MAX_FRAME_BYTES..=RPC_MAX_REASSEMBLED_BYTES).contains(&byte_length)
        {
            return Err("Invalid RPC chunk metadata");
        }
        let data = decode_base64(frame.get("data").and_then(Value::as_str).unwrap_or(""))?;
        if data.len() > CHUNK_PAYLOAD_BYTES {
            return Err("RPC chunk payload exceeds the transport limit");
        }
        if self.pending.is_none() {
            if index != 0 {
                return Err("RPC chunk sequence must start at index 0");
            }
            self.pending = Some(Pending {
                chunk_id: chunk_id.to_owned(),
                count,
                byte_length,
                next_index: 0,
                received: 0,
                bytes: Vec::new(),
            });
        }
        let Some(pending) = self.pending.as_mut() else {
            return Err("RPC chunk sequence mismatch");
        };
        if pending.chunk_id != chunk_id
            || pending.count != count
            || pending.byte_length != byte_length
            || pending.next_index != index
        {
            return Err("RPC chunk sequence mismatch");
        }
        pending.received += data.len() as u64;
        pending.bytes.extend_from_slice(&data);
        pending.next_index += 1;
        if pending.received > pending.byte_length {
            return Err("RPC chunk sequence exceeds declared length");
        }
        if pending.next_index < pending.count {
            return Ok(None);
        }
        if pending.received != pending.byte_length {
            return Err("RPC chunk sequence length mismatch");
        }
        Ok(self.pending.take().map(|pending| pending.bytes))
    }
}

/// Turns the lines of one omp's stdout into frames (`attachNdjsonParser`).
#[derive(Default)]
pub struct Decoder {
    reassembler: ChunkReassembler,
}

impl Decoder {
    /// One line (its terminator already cut off). A line that is no JSON object, an invalid chunk and a chunk
    /// sequence a normal frame interrupted give nothing.
    pub fn line(&mut self, line: &[u8]) -> Option<Frame> {
        let text = String::from_utf8_lossy(line);
        let trimmed = js_trim(&text);
        if trimmed.is_empty() {
            return None;
        }
        let Some((ty, _)) = head_of(trimmed) else {
            self.reassembler.clear();
            return None;
        };
        if ty.as_deref() == Some("rpc_chunk") {
            return self.chunk(trimmed);
        }
        // Protocol v2 sequences are contiguous. A normal frame interrupts and invalidates an incomplete sequence,
        // but remains independently usable.
        self.reassembler.clear();
        Some(Frame {
            raw: trimmed.as_bytes().to_vec(),
            ty,
        })
    }

    fn chunk(&mut self, text: &str) -> Option<Frame> {
        let Ok(frame) = serde_json::from_str::<Value>(text) else {
            self.reassembler.clear();
            return None;
        };
        let whole = match self.reassembler.feed(&frame) {
            Ok(Some(whole)) => whole,
            Ok(None) => return None,
            Err(_) => return None,
        };
        let Ok(text) = String::from_utf8(whole) else {
            return None;
        };
        // An object only: anything else the sequence held is dropped, as `onFrame` was never called for it.
        let (ty, _) = head_of(&text)?;
        Some(Frame {
            raw: text.into_bytes(),
            ty,
        })
    }
}

/// Splits a byte stream into lines at `\n`, `\r\n` and a lone `\r` (readline's line ends); the lines of a chunk are
/// handed out as they complete. An empty line is dropped: a frame never is one.
#[derive(Default)]
pub struct Lines {
    held: Vec<u8>,
}

impl Lines {
    pub fn push(&mut self, chunk: &[u8], mut each: impl FnMut(&[u8])) {
        let mut start = 0;
        for (at, &byte) in chunk.iter().enumerate() {
            if byte != b'\n' && byte != b'\r' {
                continue;
            }
            if self.held.is_empty() {
                if at > start {
                    each(&chunk[start..at]);
                }
            } else {
                self.held.extend_from_slice(&chunk[start..at]);
                each(&self.held);
                self.held.clear();
            }
            start = at + 1;
        }
        self.held.extend_from_slice(&chunk[start..]);
    }

    /// The stream ended: what it held without a line end is the last line.
    pub fn finish(&mut self, mut each: impl FnMut(&[u8])) {
        if !self.held.is_empty() {
            each(&self.held);
            self.held.clear();
        }
    }
}

fn is_final(c: char) -> bool {
    matches!(c, '0'..='9' | 'A'..='P' | 'R'..='T' | 'Z' | 'c' | 'f'..='n' | 't' | 'q' | 'r' | 'y' | '=' | '>' | '<' | '~')
}

fn is_param(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(
            c,
            '-' | '/' | '#' | '&' | '.' | ':' | '=' | '?' | '%' | '@' | '~' | '_'
        )
}

fn run_of(chars: &[char], from: usize, test: impl Fn(char) -> bool) -> usize {
    chars[from.min(chars.len())..]
        .iter()
        .take_while(|&&c| test(c))
        .count()
}

/// `(?:;S*)*` after a letters-and-digits run, greedy: the end of what it takes.
fn semicolon_params(chars: &[char], mut at: usize) -> usize {
    while chars.get(at) == Some(&';') {
        at += 1 + run_of(chars, at + 1, is_param);
    }
    at
}

/// The end of the alternative that closes with BEL, where `at` follows the prefix.
fn ends_with_bel(chars: &[char], at: usize) -> Option<usize> {
    let bel = |from: usize| (chars.get(from) == Some(&'\u{7}')).then_some(from + 1);
    // `(?:;S+)*`
    let mut end = at;
    while chars.get(end) == Some(&';') {
        let params = run_of(chars, end + 1, is_param);
        if params == 0 {
            break;
        }
        end += 1 + params;
    }
    if let Some(found) = bel(end) {
        return Some(found);
    }
    // `[a-zA-Z\d]+(?:;S*)*`
    let letters = run_of(chars, at, |c| c.is_ascii_alphanumeric());
    if letters > 0
        && let Some(found) = bel(semicolon_params(chars, at + letters))
    {
        return Some(found);
    }
    bel(at)
}

/// `(?:;\d{0,4})*` then the final character, with the backtracking a regular expression does.
fn digit_groups(chars: &[char], at: usize) -> Option<usize> {
    if chars.get(at) == Some(&';') {
        let digits = run_of(chars, at + 1, |c| c.is_ascii_digit()).min(4);
        for taken in (0..=digits).rev() {
            if let Some(end) = digit_groups(chars, at + 1 + taken) {
                return Some(end);
            }
        }
    }
    chars
        .get(at)
        .copied()
        .filter(|&c| is_final(c))
        .map(|_| at + 1)
}

/// `(?:\d{1,4}(?:;\d{0,4})*)?` then the final character.
fn ends_with_final(chars: &[char], at: usize) -> Option<usize> {
    let digits = run_of(chars, at, |c| c.is_ascii_digit()).min(4);
    for taken in (1..=digits).rev() {
        if let Some(end) = digit_groups(chars, at + taken) {
            return Some(end);
        }
    }
    chars
        .get(at)
        .copied()
        .filter(|&c| is_final(c))
        .map(|_| at + 1)
}

/// The end of the control sequence that starts at `start` (an ESC or a CSI), if one does.
fn control_sequence(chars: &[char], start: usize) -> Option<usize> {
    let prefix = run_of(chars, start + 1, |c| {
        matches!(c, '[' | ']' | '(' | ')' | '#' | ';' | '?')
    });
    for taken in (0..=prefix).rev() {
        let at = start + 1 + taken;
        if let Some(end) = ends_with_bel(chars, at).or_else(|| ends_with_final(chars, at)) {
            return Some(end);
        }
    }
    None
}

/// `util.stripVTControlCharacters`: the same regular expression, matched by hand.
pub fn strip_vt_control_characters(text: &str) -> Cow<'_, str> {
    if !text.contains(['\u{1b}', '\u{9b}']) {
        return Cow::Borrowed(text);
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while at < chars.len() {
        if matches!(chars[at], '\u{1b}' | '\u{9b}')
            && let Some(end) = control_sequence(&chars, at)
        {
            at = end;
            continue;
        }
        out.push(chars[at]);
        at += 1;
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FRAME_BYTES: usize = 1_048_576;
    const CHUNK_BYTES: usize = 262_144;

    fn base64(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let mut triple = [0u8; 3];
            triple[..chunk.len()].copy_from_slice(chunk);
            let acc = u32::from(triple[0]) << 16 | u32::from(triple[1]) << 8 | u32::from(triple[2]);
            for at in 0..4 {
                if at <= chunk.len() {
                    out.push(char::from(ALPHABET[(acc >> (18 - 6 * at) & 63) as usize]));
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    fn chunk_frames(payload: &[u8], chunk_id: &str) -> Vec<Value> {
        let count = payload.len().div_ceil(CHUNK_BYTES);
        (0..count)
            .map(|index| {
                let end = ((index + 1) * CHUNK_BYTES).min(payload.len());
                json!({
                    "type": "rpc_chunk", "chunkId": chunk_id, "index": index, "count": count,
                    "byteLength": payload.len(), "data": base64(&payload[index * CHUNK_BYTES..end]),
                })
            })
            .collect()
    }

    /// `supportsRpcProtocolV2`'s test.
    #[test]
    fn negotiates_v2_only_with_protocol_2_and_the_exact_framing_limits() {
        assert!(supports_v2(&json!({
            "supportedProtocolVersions": [1, 2], "maxFrameBytes": FRAME_BYTES, "maxReassembledFrameBytes": 67_108_864,
        })));
        assert!(!supports_v2(&json!({ "supportedProtocolVersions": [2] })));
        assert!(!supports_v2(&json!({
            "supportedProtocolVersions": [1, 2], "maxFrameBytes": FRAME_BYTES, "maxReassembledFrameBytes": 1,
        })));
        assert!(!supports_v2(&json!([1, 2])));
        assert!(!supports_v2(&json!(null)));
    }

    #[test]
    fn reassembles_one_bounded_contiguous_protocol_v2_frame() {
        let payload = vec![0x61u8; FRAME_BYTES];
        let mut decoder = ChunkReassembler::default();
        let mut result = None;
        for frame in chunk_frames(&payload, "frame-1") {
            result = decoder.feed(&frame).unwrap();
        }
        assert_eq!(result.as_deref(), Some(&payload[..]));
        assert!(!decoder.pending());
    }

    #[test]
    fn rejects_malformed_or_interleaved_chunks_and_releases_pending_state() {
        let payload = vec![0x62u8; FRAME_BYTES];
        let frames = chunk_frames(&payload, "frame-1");
        let mut decoder = ChunkReassembler::default();

        let mut bad = frames[0].clone();
        bad["data"] = json!("not-base64");
        assert_eq!(decoder.feed(&bad), Err("Invalid RPC chunk data"));
        assert!(!decoder.pending());

        assert_eq!(decoder.feed(&frames[0]), Ok(None));
        let mut other = frames[1].clone();
        other["chunkId"] = json!("other-frame");
        assert_eq!(decoder.feed(&other), Err("RPC chunk sequence mismatch"));
        assert!(!decoder.pending());

        let mut counted = frames[0].clone();
        counted["count"] = json!(257);
        assert_eq!(decoder.feed(&counted), Err("Invalid RPC chunk metadata"));
        assert!(!decoder.pending());
    }

    #[test]
    fn holds_each_other_rule_of_a_sequence() {
        let payload = vec![0x63u8; FRAME_BYTES];
        let frames = chunk_frames(&payload, "f");
        let mut decoder = ChunkReassembler::default();
        // A sequence starts at index 0.
        assert_eq!(
            decoder.feed(&frames[1]),
            Err("RPC chunk sequence must start at index 0")
        );
        // A piece out of order.
        decoder.feed(&frames[0]).unwrap();
        assert_eq!(decoder.feed(&frames[2]), Err("RPC chunk sequence mismatch"));
        // Too short a declared length for a chunked frame.
        let mut short = frames[0].clone();
        short["byteLength"] = json!(10);
        assert_eq!(decoder.feed(&short), Err("Invalid RPC chunk metadata"));
        // A piece past the transport limit.
        let mut big = frames[0].clone();
        big["data"] = json!(base64(&vec![1u8; CHUNK_BYTES + 3]));
        assert_eq!(
            decoder.feed(&big),
            Err("RPC chunk payload exceeds the transport limit")
        );
        // A sequence whose pieces do not add up to its length.
        let mut sum = ChunkReassembler::default();
        let mut pieces = chunk_frames(&payload, "g");
        let last = pieces.len() - 1;
        pieces[last]["data"] = json!(base64(b"short"));
        for piece in &pieces[..last] {
            assert_eq!(sum.feed(piece), Ok(None));
        }
        assert_eq!(
            sum.feed(&pieces[last]),
            Err("RPC chunk sequence length mismatch")
        );
    }

    #[test]
    fn decodes_only_the_canonical_padded_base64() {
        for bytes in [
            &b""[..],
            b"a",
            b"ab",
            b"abc",
            b"abcd",
            b"\xff\xfe\xfd\xfc\xfb",
        ] {
            if !bytes.is_empty() {
                assert_eq!(decode_base64(&base64(bytes)).unwrap(), bytes);
            }
        }
        for bad in [
            "", "YQ", "YQ=", "YR==", "YWJ=", "YQ==YQ==", "Y===", "YW Jj", "YWJj\n", "*QAA",
        ] {
            assert!(decode_base64(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn turns_lines_into_frames_and_drops_what_is_no_frame() {
        let mut decoder = Decoder::default();
        let frame = decoder
            .line(b"  {\"type\":\"agent_start\",\"x\":1}\r ")
            .unwrap();
        assert_eq!(frame.ty.as_deref(), Some("agent_start"));
        assert_eq!(frame.raw, b"{\"type\":\"agent_start\",\"x\":1}");
        assert!(decoder.line(b"   ").is_none());
        assert!(decoder.line(b"not json").is_none());
        assert!(decoder.line(b"[1,2]").is_none());
        assert!(decoder.line(b"\"text\"").is_none());
        // A type that is no string is still a frame, with none.
        assert_eq!(decoder.line(b"{\"type\":5}").unwrap().ty, None);
        assert_eq!(decoder.line(b"{}").unwrap().ty, None);
        // A key written twice: the last counts.
        assert_eq!(
            decoder
                .line(b"{\"type\":\"a\",\"type\":\"b\"}")
                .unwrap()
                .ty
                .as_deref(),
            Some("b")
        );
    }

    #[test]
    fn reassembles_a_chunked_frame_between_normal_ones_and_drops_an_interrupted_sequence() {
        let mut body = b"{\"type\":\"message_update\",\"pad\":\"".to_vec();
        body.resize(FRAME_BYTES, b'x');
        body.extend_from_slice(b"\"}");
        let pieces = chunk_frames(&body, "c1");
        let mut decoder = Decoder::default();
        let mut got = None;
        for piece in &pieces {
            assert!(got.is_none());
            got = decoder.line(piece.to_string().as_bytes());
        }
        let got = got.unwrap();
        assert_eq!(got.ty.as_deref(), Some("message_update"));
        assert_eq!(got.raw, body);

        // A normal frame between two pieces invalidates the sequence but stays usable itself.
        decoder.line(pieces[0].to_string().as_bytes());
        let normal = decoder.line(b"{\"type\":\"agent_end\"}").unwrap();
        assert_eq!(normal.ty.as_deref(), Some("agent_end"));
        for piece in &pieces[1..] {
            assert!(decoder.line(piece.to_string().as_bytes()).is_none());
        }
    }

    #[test]
    fn splits_a_stream_at_every_line_end_however_the_pipe_cut_it() {
        let mut lines = Lines::default();
        let mut got: Vec<String> = Vec::new();
        let mut take = |line: &[u8]| got.push(String::from_utf8(line.to_vec()).unwrap());
        lines.push(b"{\"a\":1}\n{\"b\"", &mut take);
        lines.push(b":2}\r\n\r\n{\"c\":3}", &mut take);
        lines.push(b"\r{\"d\":4}\n", &mut take);
        assert_eq!(got, ["{\"a\":1}", "{\"b\":2}", "{\"c\":3}", "{\"d\":4}"]);
    }

    #[test]
    fn trims_as_javascript_does() {
        assert_eq!(js_trim("\u{feff} a b\u{a0}\n"), "a b");
        // U+0085 is Unicode white space but not JavaScript's.
        assert_eq!(js_trim("\u{85}a\u{85}"), "\u{85}a\u{85}");
    }

    /// Captured from node 24's `util.stripVTControlCharacters`.
    #[test]
    fn strips_control_sequences_as_node_does() {
        let table: &[(&str, &str)] = &[
            ("plain", "plain"),
            ("\u{1b}[31mred\u{1b}[0m", "red"),
            ("\u{1b}[1;31mbold\u{1b}[m x", "bold x"),
            ("a\u{1b}]8;;http://x\u{7}link\u{1b}]8;;\u{7}b", "alinkb"),
            ("\u{1b}[31", ""),
            ("\u{1b}[", "\u{1b}["),
            ("\u{1b}[;5H", ""),
            ("\u{1b}(Bq", "q"),
            ("\u{9b}2Jz", "z"),
            ("\u{1b}[?25l\u{1b}[?25h", ""),
            ("\u{1b}c", ""),
            ("\u{1b}[12345m", "m"),
            ("\u{1b}[1;2;3;4;5;6m!", "!"),
            ("\u{1b}[38;5;196mcolor", "color"),
            ("\u{1b}[K\r\n", "\r\n"),
            ("error: \u{1b}[1mENOENT\u{1b}[22m x", "error: ENOENT x"),
            ("\u{1b}]0;title\u{7}t", "t"),
            ("\u{1b}#8", ""),
            ("\u{1b}[99999;5Hxy", ";5Hxy"),
            ("\u{1b}[1;;2m", ""),
            ("\u{1b}Z", ""),
            ("\u{1b}[;", "\u{1b}[;"),
            ("\u{1b}x", "\u{1b}x"),
        ];
        for (input, expected) in table {
            assert_eq!(strip_vt_control_characters(input), *expected, "{input:?}");
        }
    }
}
