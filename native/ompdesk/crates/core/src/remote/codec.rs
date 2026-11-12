//! The remote link's framing, sealing and deflate, as pure state (was `src/main/remote/wire.ts` lines 1-205 and the
//! body choice and decode of `Link`): a 4-byte big-endian length and at most 16 MiB of payload; after the handshake
//! every payload is `counter(12) || AES-256-GCM(body) || tag(16)` with the 96-bit counter as the nonce, one key per
//! direction, received counters strictly increasing. A body is the message's JSON, or `0x00 || deflate-raw(JSON)`
//! (level 3, a message of 1 KiB or more, when smaller), or `0x01 || deflate-raw(JSON)` against the last 32 KiB of
//! the messages that crossed that way before it (level 6 up to 64 KiB, else 3; 64 B or more; when smaller).
//!
//! No socket and no timer: the link task (`link.rs`) owns those and asks this module for bytes.

use std::borrow::Cow;

use aes_gcm::aead::AeadInOut;
use aes_gcm::aead::KeyInit;
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};

pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// The smallest message worth deflating on its own.
pub const DEFLATE_MIN_BYTES: usize = 1024;
/// How much of the messages before it a message is deflated against: deflate's whole window.
pub const CONTEXT_BYTES: usize = 32 * 1024;
/// Smaller than this crosses as JSON: a ping or a pong.
pub const CONTEXT_MIN_BYTES: usize = 64;
/// Up to this size a message in the context is deflated harder.
const CONTEXT_HARD_MAX_BYTES: usize = 64 * 1024;
const CONTEXT_HARD_LEVEL: u32 = 6;
const DEFLATE_LEVEL: u32 = 3;
/// The first byte of a deflated body; a JSON one starts with `{` (or white space).
const DEFLATED: u8 = 0x00;
const DEFLATED_IN_CONTEXT: u8 = 0x01;
const HEADER_BYTES: usize = 4;
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

/// Why a frame or a message was refused. Every one ends the link (`protocol`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecError {
    /// A frame, or a message, past the 16 MiB cap.
    FrameTooLarge(usize),
    /// An encrypted frame shorter than its nonce and tag.
    Short,
    CounterNotIncreasing,
    /// The tag did not verify.
    Auth,
    /// A `0x00` or `0x01` payload before the link is secure: an unauthenticated peer never gets this side to inflate.
    DeflatedBeforeSecure,
    /// The deflate stream is damaged, or ends before its end marker.
    Inflate,
    /// The inflated message is past the 16 MiB cap.
    InflatedTooLarge,
    /// `JSON.parse` would throw.
    NotJson,
    NotObject,
    NoType,
}

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodecError::FrameTooLarge(bytes) => {
                write!(f, "frame of {bytes} bytes exceeds the 16 MiB cap")
            }
            CodecError::Short => f.write_str("encrypted frame too short"),
            CodecError::CounterNotIncreasing => f.write_str("frame counter did not increase"),
            CodecError::Auth => f.write_str("frame did not authenticate"),
            CodecError::DeflatedBeforeSecure => {
                f.write_str("deflated frame before the link is secure")
            }
            CodecError::Inflate => f.write_str("deflated frame did not inflate"),
            CodecError::InflatedTooLarge => f.write_str("inflated frame exceeds the 16 MiB cap"),
            CodecError::NotJson => f.write_str("message is not JSON"),
            CodecError::NotObject => f.write_str("not an object"),
            CodecError::NoType => f.write_str("message without a type"),
        }
    }
}

impl std::error::Error for CodecError {}

/// `payload` behind its 4-byte big-endian length; a payload past the cap is refused.
pub fn encode_frame(payload: &[u8]) -> Result<Vec<u8>, CodecError> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(CodecError::FrameTooLarge(payload.len()));
    }
    let mut frame = Vec::with_capacity(HEADER_BYTES + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

/// Splits a byte stream into frame payloads; refuses a length past the cap.
#[derive(Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
    /// The payload length of the frame whose header was read.
    need: Option<usize>,
}

impl FrameDecoder {
    pub fn new() -> FrameDecoder {
        FrameDecoder::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, CodecError> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut at = 0;
        let outcome = loop {
            let available = &self.buffer[at..];
            let need = match self.need {
                Some(need) => need,
                None => {
                    let Some(header) = available.first_chunk::<HEADER_BYTES>() else {
                        break Ok(());
                    };
                    let length = u32::from_be_bytes(*header) as usize;
                    if length > MAX_FRAME_BYTES {
                        break Err(CodecError::FrameTooLarge(length));
                    }
                    self.need = Some(length);
                    length
                }
            };
            if available.len() < HEADER_BYTES + need {
                break Ok(());
            }
            frames.push(available[HEADER_BYTES..HEADER_BYTES + need].to_vec());
            at += HEADER_BYTES + need;
            self.need = None;
        };
        self.buffer.drain(..at);
        outcome.map(|()| frames)
    }
}

fn nonce(counter: u128) -> [u8; NONCE_BYTES] {
    let bytes = counter.to_be_bytes();
    let mut iv = [0u8; NONCE_BYTES];
    iv.copy_from_slice(&bytes[4..]);
    iv
}

/// Encrypts outgoing payloads under one direction key with a counting nonce, from 0.
pub struct Sealer {
    cipher: Aes256Gcm,
    counter: u128,
}

impl Sealer {
    pub fn new(key: &[u8; 32]) -> Sealer {
        Sealer {
            cipher: Aes256Gcm::new(key.into()),
            counter: 0,
        }
    }

    /// `counter(12) || ciphertext || tag(16)`.
    pub fn seal(&mut self, plain: &[u8]) -> Vec<u8> {
        // 2^96 frames cannot be sent (nonce reuse would break the cipher): the TypeScript threw a RangeError here.
        assert!(self.counter >> 96 == 0, "frame counter exhausted");
        let iv = nonce(self.counter);
        self.counter += 1;
        let mut frame = Vec::with_capacity(NONCE_BYTES + plain.len() + TAG_BYTES);
        frame.extend_from_slice(&iv);
        frame.extend_from_slice(plain);
        let tag = self
            .cipher
            .encrypt_inout_detached(&Nonce::from(iv), &[], (&mut frame[NONCE_BYTES..]).into())
            .expect("AES-GCM seals any payload under the frame cap");
        frame.extend_from_slice(&tag);
        frame
    }

    /// A sealer that continues from `counter`: the vectors reach counters no test could count up to.
    #[cfg(test)]
    pub(crate) fn at(key: &[u8; 32], counter: u128) -> Sealer {
        Sealer {
            counter,
            ..Sealer::new(key)
        }
    }
}

/// Decrypts incoming payloads; refuses a bad tag and a counter that did not increase.
pub struct Opener {
    cipher: Aes256Gcm,
    last: Option<u128>,
}

impl Opener {
    pub fn new(key: &[u8; 32]) -> Opener {
        Opener {
            cipher: Aes256Gcm::new(key.into()),
            last: None,
        }
    }

    pub fn open(&mut self, frame: &[u8]) -> Result<Vec<u8>, CodecError> {
        if frame.len() < NONCE_BYTES + TAG_BYTES {
            return Err(CodecError::Short);
        }
        let (iv, rest) = frame.split_at(NONCE_BYTES);
        let (cipher_text, tag) = rest.split_at(rest.len() - TAG_BYTES);
        let iv: [u8; NONCE_BYTES] = iv.try_into().expect("split at the nonce length");
        let tag: [u8; TAG_BYTES] = tag.try_into().expect("split at the tag length");
        let mut wide = [0u8; 16];
        wide[4..].copy_from_slice(&iv);
        let counter = u128::from_be_bytes(wide);
        if self.last.is_some_and(|last| counter <= last) {
            return Err(CodecError::CounterNotIncreasing);
        }
        let mut plain = cipher_text.to_vec();
        self.cipher
            .decrypt_inout_detached(
                &Nonce::from(iv),
                &[],
                (&mut plain[..]).into(),
                &Tag::from(tag),
            )
            .map_err(|_| CodecError::Auth)?;
        self.last = Some(counter);
        Ok(plain)
    }
}

/// The last `CONTEXT_BYTES` of the messages one end deflated against the context (or inflated from it), as one
/// contiguous dictionary. It slides once a window, not on every message.
#[derive(Default)]
struct Context {
    bytes: Vec<u8>,
}

impl Context {
    /// The dictionary for the next message; none before the first, which zlib takes with none.
    fn dictionary(&self) -> Option<&[u8]> {
        if self.bytes.is_empty() {
            None
        } else {
            Some(&self.bytes[self.bytes.len().saturating_sub(CONTEXT_BYTES)..])
        }
    }

    fn append(&mut self, json: &[u8]) {
        if json.len() >= CONTEXT_BYTES {
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&json[json.len() - CONTEXT_BYTES..]);
            return;
        }
        if self.bytes.len() + json.len() > 2 * CONTEXT_BYTES {
            let from = self.bytes.len() - CONTEXT_BYTES;
            self.bytes.drain(..from);
        }
        self.bytes.extend_from_slice(json);
    }
}

/// What a message crosses as: its JSON itself, or the deflated form behind its marker.
pub struct Body<'a> {
    pub bytes: Cow<'a, [u8]>,
    /// The message joins the sent context once it is written (`Outgoing::commit`).
    pub in_context: bool,
}

/// What one end sends. Deflating starts when the peer said it reads it (`Link.deflateSent`).
#[derive(Default)]
pub struct Outgoing {
    deflate: bool,
    /// What this end deflates against; none while it does not.
    context: Option<Context>,
    /// One state per level, reset for each message: a deflate state is a few hundred KB to allocate.
    level3: Option<Compress>,
    level6: Option<Compress>,
}

impl Outgoing {
    pub fn new() -> Outgoing {
        Outgoing::default()
    }

    /// Deflate large messages from now on; with `context` every message of `CONTEXT_MIN_BYTES` or more goes deflated
    /// against the ones before it when that makes it smaller.
    pub fn deflate(&mut self, context: bool) {
        self.deflate = true;
        if context && self.context.is_none() {
            self.context = Some(Context::default());
        }
    }

    /// The body for `json` (before sealing). A message past the cap is refused whatever it would deflate to: the
    /// cap is the receiver's after inflating.
    pub fn body<'a>(&mut self, json: &'a [u8]) -> Result<Body<'a>, CodecError> {
        if json.len() > MAX_FRAME_BYTES {
            return Err(CodecError::FrameTooLarge(json.len()));
        }
        let packed = match &self.context {
            Some(_) if json.len() >= CONTEXT_MIN_BYTES => {
                let level = if json.len() <= CONTEXT_HARD_MAX_BYTES {
                    CONTEXT_HARD_LEVEL
                } else {
                    DEFLATE_LEVEL
                };
                self.pack(json, level, DEFLATED_IN_CONTEXT, true)
            }
            Some(_) => None,
            None if self.deflate && json.len() >= DEFLATE_MIN_BYTES => {
                self.pack(json, DEFLATE_LEVEL, DEFLATED, false)
            }
            None => None,
        };
        Ok(match packed {
            Some(bytes) => Body {
                bytes: Cow::Owned(bytes),
                in_context: self.context.is_some(),
            },
            None => Body {
                bytes: Cow::Borrowed(json),
                in_context: false,
            },
        })
    }

    /// Append `json` to the sent context: only after a successful write of an in-context body, so a send that failed
    /// leaves both ends' copies as they were.
    pub fn commit(&mut self, json: &[u8]) {
        if let Some(context) = &mut self.context {
            context.append(json);
        }
    }

    /// `marker || deflate-raw(json)`, or none when that is not smaller than `json`.
    fn pack(&mut self, json: &[u8], level: u32, marker: u8, with_context: bool) -> Option<Vec<u8>> {
        let slot = if level == CONTEXT_HARD_LEVEL {
            &mut self.level6
        } else {
            &mut self.level3
        };
        let deflater = slot.get_or_insert_with(|| Compress::new(Compression::new(level), false));
        deflater.reset();
        if with_context
            && let Some(dictionary) = self.context.as_ref().and_then(Context::dictionary)
        {
            deflater.set_dictionary(dictionary).ok()?;
        }
        // Room for one byte less than `json`: a longer result is no gain, and the compressor stops at the limit.
        let mut out = Vec::with_capacity(json.len() - 1);
        out.push(marker);
        match deflater.compress_vec(json, &mut out, FlushCompress::Finish) {
            Ok(Status::StreamEnd) if out.len() < json.len() => Some(out),
            _ => None,
        }
    }
}

/// What one end receives: it reads every form, and keeps the context the peer deflates against.
#[derive(Default)]
pub struct Incoming {
    /// What the peer deflated against, made at its first such message.
    context: Option<Context>,
    inflater: Option<Decompress>,
}

impl Incoming {
    pub fn new() -> Incoming {
        Incoming::default()
    }

    /// The message's JSON from a payload's body. `secure`: whether the link was secured when it arrived (a `0x00` or
    /// `0x01` before is a protocol error: the handshake is JSON).
    pub fn json<'a>(&mut self, body: &'a [u8], secure: bool) -> Result<Cow<'a, [u8]>, CodecError> {
        let marker = body.first().copied();
        if !secure {
            return match marker {
                Some(DEFLATED | DEFLATED_IN_CONTEXT) => Err(CodecError::DeflatedBeforeSecure),
                _ => Ok(Cow::Borrowed(body)),
            };
        }
        match marker {
            Some(DEFLATED) => Ok(Cow::Owned(self.inflate(&body[1..], None)?)),
            Some(DEFLATED_IN_CONTEXT) => {
                let context = self.context.get_or_insert_with(Context::default);
                let dictionary = context.dictionary().map(<[u8]>::to_vec);
                let json = {
                    let inflater = self.inflater.get_or_insert_with(|| Decompress::new(false));
                    inflate(inflater, &body[1..], dictionary.as_deref())?
                };
                context.append(&json);
                Ok(Cow::Owned(json))
            }
            _ => Ok(Cow::Borrowed(body)),
        }
    }

    fn inflate(&mut self, packed: &[u8], dictionary: Option<&[u8]>) -> Result<Vec<u8>, CodecError> {
        let inflater = self.inflater.get_or_insert_with(|| Decompress::new(false));
        inflate(inflater, packed, dictionary)
    }
}

/// `inflateRawSync(packed, { dictionary, maxOutputLength: MAX_FRAME_BYTES })`: bytes after the end of the deflate
/// stream are ignored, a stream that ends early or damaged is refused, and so is an output past the cap.
fn inflate(
    inflater: &mut Decompress,
    packed: &[u8],
    dictionary: Option<&[u8]>,
) -> Result<Vec<u8>, CodecError> {
    inflater.reset(false);
    if let Some(dictionary) = dictionary {
        inflater
            .set_dictionary(dictionary)
            .map_err(|_| CodecError::Inflate)?;
    }
    let mut out = Vec::with_capacity(
        packed
            .len()
            .saturating_mul(4)
            .clamp(1024, MAX_FRAME_BYTES + 1),
    );
    loop {
        let (read, written) = (inflater.total_in(), inflater.total_out());
        let status = inflater
            .decompress_vec(&packed[read as usize..], &mut out, FlushDecompress::None)
            .map_err(|_| CodecError::Inflate)?;
        if out.len() > MAX_FRAME_BYTES {
            return Err(CodecError::InflatedTooLarge);
        }
        if status == Status::StreamEnd {
            return Ok(out);
        }
        if out.len() == out.capacity() {
            let more = out
                .capacity()
                .clamp(4096, MAX_FRAME_BYTES + 1 - out.capacity());
            out.reserve_exact(more);
        } else if inflater.total_in() == read && inflater.total_out() == written {
            return Err(CodecError::Inflate);
        }
    }
}

/// A received message must be a JSON object with a string `t` (else protocol): what `Link.#decode` checks after
/// `JSON.parse`, which it accepts as `JSON.parse` does, invalid UTF-8 and lone surrogate escapes included. Returns `t`
/// (a lone surrogate in it reads as U+FFFD).
pub fn message_type(json: &[u8]) -> Result<String, CodecError> {
    let parsed = scan::parse(json).map_err(|_| CodecError::NotJson)?;
    if !parsed.top_is_object {
        return Err(CodecError::NotObject);
    }
    let (start, end) = parsed.t.ok_or(CodecError::NoType)?;
    Ok(String::from_utf16_lossy(&scan::unescape(
        &json[start + 1..end - 1],
    )))
}

/// A JSON reader that accepts exactly what `JSON.parse` accepts (RFC 8259 grammar, any depth, strings of any bytes
/// without a control character, `\u` escapes of any value), and walks a document without building one.
pub(crate) mod scan {
    /// The text is not JSON.
    #[derive(Debug)]
    pub struct Bad;

    pub struct Parsed {
        pub top_is_object: bool,
        /// The last top-level `"t"` entry's value, when it is a string: the span of its token, quotes included.
        pub t: Option<(usize, usize)>,
    }

    fn is_space(b: u8) -> bool {
        matches!(b, b' ' | b'\t' | b'\n' | b'\r')
    }

    fn skip_space(src: &[u8], mut at: usize) -> usize {
        while src.get(at).is_some_and(|&b| is_space(b)) {
            at += 1;
        }
        at
    }

    /// The end of the string token that starts at `at` (a quote), refusing what JSON refuses.
    pub fn string_end(src: &[u8], at: usize) -> Result<usize, Bad> {
        let mut i = at + 1;
        loop {
            match *src.get(i).ok_or(Bad)? {
                b'"' => return Ok(i + 1),
                b'\\' => match *src.get(i + 1).ok_or(Bad)? {
                    b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => i += 2,
                    b'u' => {
                        let digits = src.get(i + 2..i + 6).ok_or(Bad)?;
                        if !digits.iter().all(u8::is_ascii_hexdigit) {
                            return Err(Bad);
                        }
                        i += 6;
                    }
                    _ => return Err(Bad),
                },
                0..=0x1f => return Err(Bad),
                _ => i += 1,
            }
        }
    }

    fn digits(src: &[u8], mut at: usize) -> Result<usize, Bad> {
        let start = at;
        while src.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == start { Err(Bad) } else { Ok(at) }
    }

    fn number_end(src: &[u8], mut at: usize) -> Result<usize, Bad> {
        if src.get(at) == Some(&b'-') {
            at += 1;
        }
        match src.get(at) {
            Some(b'0') => at += 1,
            Some(b'1'..=b'9') => at = digits(src, at)?,
            _ => return Err(Bad),
        }
        if src.get(at) == Some(&b'.') {
            at = digits(src, at + 1)?;
        }
        if matches!(src.get(at), Some(b'e' | b'E')) {
            at += 1;
            if matches!(src.get(at), Some(b'+' | b'-')) {
                at += 1;
            }
            at = digits(src, at)?;
        }
        Ok(at)
    }

    fn literal_end(src: &[u8], at: usize, word: &[u8]) -> Result<usize, Bad> {
        if src.get(at..at + word.len()) == Some(word) {
            Ok(at + word.len())
        } else {
            Err(Bad)
        }
    }

    enum State {
        Value,
        Key,
        After,
    }

    /// Validates `src` as one JSON document (white space around it allowed) and finds the top-level `t`.
    pub fn parse(src: &[u8]) -> Result<Parsed, Bad> {
        let mut at = skip_space(src, 0);
        let mut parsed = Parsed {
            top_is_object: src.get(at) == Some(&b'{'),
            t: None,
        };
        // Containers still open, innermost last.
        let mut open: Vec<u8> = Vec::new();
        let mut state = State::Value;
        let mut key_is_t = false;
        loop {
            match state {
                State::Value => {
                    let first = *src.get(at).ok_or(Bad)?;
                    if key_is_t && open.len() == 1 && open[0] == b'{' {
                        // The value of a top-level `t`: a later `t` replaces this one, whatever it holds.
                        parsed.t = (first == b'"').then_some((at, 0));
                        key_is_t = false;
                    }
                    match first {
                        b'"' => {
                            let end = string_end(src, at)?;
                            if let Some(t) = &mut parsed.t
                                && t.0 == at
                            {
                                t.1 = end;
                            }
                            at = end;
                            state = State::After;
                        }
                        b'{' => {
                            at = skip_space(src, at + 1);
                            if src.get(at) == Some(&b'}') {
                                at += 1;
                                state = State::After;
                            } else {
                                open.push(b'{');
                                state = State::Key;
                            }
                        }
                        b'[' => {
                            at = skip_space(src, at + 1);
                            if src.get(at) == Some(&b']') {
                                at += 1;
                                state = State::After;
                            } else {
                                open.push(b'[');
                            }
                        }
                        b'-' | b'0'..=b'9' => {
                            at = number_end(src, at)?;
                            state = State::After;
                        }
                        b't' => {
                            at = literal_end(src, at, b"true")?;
                            state = State::After;
                        }
                        b'f' => {
                            at = literal_end(src, at, b"false")?;
                            state = State::After;
                        }
                        b'n' => {
                            at = literal_end(src, at, b"null")?;
                            state = State::After;
                        }
                        _ => return Err(Bad),
                    }
                }
                State::Key => {
                    if src.get(at) != Some(&b'"') {
                        return Err(Bad);
                    }
                    let end = string_end(src, at)?;
                    if open.len() == 1 {
                        key_is_t = is_t(&src[at + 1..end - 1]);
                    }
                    at = skip_space(src, end);
                    if src.get(at) != Some(&b':') {
                        return Err(Bad);
                    }
                    at = skip_space(src, at + 1);
                    state = State::Value;
                }
                State::After => {
                    let Some(&innermost) = open.last() else { break };
                    at = skip_space(src, at);
                    match (src.get(at), innermost) {
                        (Some(b','), b'[') => {
                            at = skip_space(src, at + 1);
                            state = State::Value;
                        }
                        (Some(b','), _) => {
                            at = skip_space(src, at + 1);
                            state = State::Key;
                        }
                        (Some(b'}'), b'{') | (Some(b']'), b'[') => {
                            open.pop();
                            at += 1;
                        }
                        _ => return Err(Bad),
                    }
                }
            }
        }
        if skip_space(src, at) != src.len() {
            return Err(Bad);
        }
        Ok(parsed)
    }

    fn is_t(inner: &[u8]) -> bool {
        key_is(inner, "t")
    }

    /// Whether a key's text between its quotes is `wanted` (ASCII), escaped or not.
    pub fn key_is(inner: &[u8], wanted: &str) -> bool {
        inner == wanted.as_bytes()
            || (inner.contains(&b'\\')
                && unescape(inner)
                    .iter()
                    .copied()
                    .eq(wanted.bytes().map(u16::from)))
    }

    /// A string's text between its quotes as UTF-16 code units, as a JavaScript string holds it: an invalid UTF-8
    /// sequence reads as U+FFFD (`Buffer.toString("utf8")`), a lone surrogate escape stays a lone surrogate.
    pub fn unescape(inner: &[u8]) -> Vec<u16> {
        let mut units = Vec::with_capacity(inner.len());
        let mut at = 0;
        while at < inner.len() {
            let run = inner[at..]
                .iter()
                .position(|&b| b == b'\\')
                .unwrap_or(inner.len() - at);
            units.extend(String::from_utf8_lossy(&inner[at..at + run]).encode_utf16());
            at += run;
            if at >= inner.len() {
                break;
            }
            let escaped = inner.get(at + 1).copied().unwrap_or(b'\\');
            at += 2;
            units.push(match escaped {
                b'b' => 8,
                b'f' => 12,
                b'n' => 10,
                b'r' => 13,
                b't' => 9,
                b'u' => {
                    let unit = inner
                        .get(at..at + 4)
                        .and_then(|hex| std::str::from_utf8(hex).ok())
                        .and_then(|hex| u16::from_str_radix(hex, 16).ok())
                        .unwrap_or(0xfffd);
                    at += 4;
                    unit
                }
                other => u16::from(other),
            });
        }
        units
    }

    /// The end of the value that starts at `at`, without checking it: for a document already validated.
    fn skip_value(src: &[u8], at: usize) -> Option<usize> {
        match *src.get(at)? {
            b'"' => string_end(src, at).ok(),
            b'{' | b'[' => {
                let mut depth = 0usize;
                let mut i = at;
                loop {
                    match *src.get(i)? {
                        b'"' => {
                            i = string_end(src, i).ok()?;
                            continue;
                        }
                        b'{' | b'[' => depth += 1,
                        b'}' | b']' => {
                            depth -= 1;
                            if depth == 0 {
                                return Some(i + 1);
                            }
                        }
                        _ => {}
                    }
                    i += 1;
                }
            }
            _ => {
                let len = src[at..]
                    .iter()
                    .position(|&b| is_space(b) || matches!(b, b',' | b'}' | b']'))
                    .unwrap_or(src.len() - at);
                // A delimiter where a value belongs is no value: stepping past nothing would never end.
                (len > 0).then_some(at + len)
            }
        }
    }

    /// One value of a validated document, as its token text. Anything it cannot read reads as absent: a document
    /// that was not validated gives odd answers, never a panic.
    #[derive(Clone, Copy)]
    pub struct Value<'a>(&'a [u8]);

    impl<'a> Value<'a> {
        /// The value that fills `src`, white space around it aside.
        pub fn root(src: &'a [u8]) -> Option<Value<'a>> {
            let at = skip_space(src, 0);
            let end = skip_value(src, at)?;
            Some(Value(&src[at..end]))
        }

        fn first(&self) -> u8 {
            self.0.first().copied().unwrap_or(0)
        }

        pub fn is_object(&self) -> bool {
            self.first() == b'{'
        }

        pub fn is_array(&self) -> bool {
            self.first() == b'['
        }

        /// The token's bytes, which equal `JSON.stringify` of the value for JSON that `JSON.stringify` wrote.
        pub fn raw(&self) -> &'a [u8] {
            self.0
        }

        /// A string's UTF-16 code units; none for another kind of value.
        pub fn string(&self) -> Option<Vec<u16>> {
            (self.first() == b'"' && self.0.len() >= 2)
                .then(|| unescape(&self.0[1..self.0.len() - 1]))
        }

        /// A number as JavaScript reads it (`1e999` is infinity); none for another kind of value.
        pub fn number(&self) -> Option<f64> {
            if !matches!(self.first(), b'-' | b'0'..=b'9') {
                return None;
            }
            std::str::from_utf8(self.0).ok()?.parse().ok()
        }

        /// An object's entries in document order, each key as its text between the quotes.
        pub fn entries(&self) -> Entries<'a> {
            Entries {
                src: self.0,
                at: if self.is_object() { 1 } else { self.0.len() },
            }
        }

        /// An array's items.
        pub fn items(&self) -> Items<'a> {
            Items {
                src: self.0,
                at: if self.is_array() { 1 } else { self.0.len() },
            }
        }

        /// The value of `key` in an object: the last entry of that name, as `JSON.parse` keeps it.
        pub fn get(&self, key: &str) -> Option<Value<'a>> {
            let mut found = None;
            for (name, value) in self.entries() {
                if key_is(name, key) {
                    found = Some(value);
                }
            }
            found
        }

        /// Whether an object has an entry named `key`.
        pub fn has(&self, key: &str) -> bool {
            self.get(key).is_some()
        }
    }

    pub struct Entries<'a> {
        src: &'a [u8],
        at: usize,
    }

    impl<'a> Iterator for Entries<'a> {
        type Item = (&'a [u8], Value<'a>);

        fn next(&mut self) -> Option<Self::Item> {
            let src = self.src;
            let mut at = skip_space(src, self.at);
            if src.get(at)? == &b',' {
                at = skip_space(src, at + 1);
            }
            if src.get(at) != Some(&b'"') {
                self.at = src.len();
                return None;
            }
            let key_end = string_end(src, at).ok()?;
            let key = &src[at + 1..key_end - 1];
            at = skip_space(src, key_end);
            if src.get(at) != Some(&b':') {
                self.at = src.len();
                return None;
            }
            at = skip_space(src, at + 1);
            let end = skip_value(src, at)?;
            self.at = end;
            Some((key, Value(&src[at..end])))
        }
    }

    pub struct Items<'a> {
        src: &'a [u8],
        at: usize,
    }

    impl<'a> Iterator for Items<'a> {
        type Item = Value<'a>;

        fn next(&mut self) -> Option<Self::Item> {
            let src = self.src;
            let mut at = skip_space(src, self.at);
            if src.get(at)? == &b',' {
                at = skip_space(src, at + 1);
            }
            if matches!(src.get(at), None | Some(b']')) {
                self.at = src.len();
                return None;
            }
            let end = skip_value(src, at)?;
            self.at = end;
            Some(Value(&src[at..end]))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use serde_json::Value;

    fn captured() -> Value {
        serde_json::from_str(include_str!("codec-captured.json")).unwrap()
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn unb64(s: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD.decode(s).unwrap()
    }

    fn key(hex: &Value) -> [u8; 32] {
        unhex(hex.as_str().unwrap()).try_into().unwrap()
    }

    fn units(t: &Value) -> String {
        let units: Vec<u16> = t
            .as_array()
            .unwrap()
            .iter()
            .map(|u| u.as_u64().unwrap() as u16)
            .collect();
        String::from_utf16_lossy(&units)
    }

    #[test]
    fn frames_encode_as_the_typescript_does_and_the_cap_is_inclusive() {
        for row in captured()["encodeFrame"].as_array().unwrap() {
            let payload = unhex(row["payload"].as_str().unwrap());
            assert_eq!(
                encode_frame(&payload).unwrap(),
                unhex(row["frame"].as_str().unwrap())
            );
        }
        assert_eq!(
            encode_frame(&vec![0; MAX_FRAME_BYTES]).unwrap().len(),
            MAX_FRAME_BYTES + 4
        );
        assert_eq!(
            encode_frame(&vec![0; MAX_FRAME_BYTES + 1]),
            Err(CodecError::FrameTooLarge(MAX_FRAME_BYTES + 1))
        );
    }

    #[test]
    fn the_decoder_splits_streams_as_the_typescript_does() {
        let rows = captured();
        let rows = rows["decoder"].as_array().unwrap();
        assert!(rows.len() >= 20);
        for row in rows {
            let label = row["name"].as_str().unwrap();
            let mut decoder = FrameDecoder::new();
            let chunks = row["chunks"].as_array().unwrap();
            let steps = row["steps"].as_array().unwrap();
            assert!(steps.len() <= chunks.len());
            for (n, step) in steps.iter().enumerate() {
                let got = decoder.push(&unhex(chunks[n].as_str().unwrap()));
                match step.get("frames") {
                    Some(frames) => {
                        let got = got.unwrap_or_else(|e| panic!("{label} chunk {n}: {e}"));
                        let want: Vec<Vec<u8>> = frames
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|f| unhex(f.as_str().unwrap()))
                            .collect();
                        assert_eq!(got, want, "{label} chunk {n}");
                    }
                    None => assert!(
                        matches!(got, Err(CodecError::FrameTooLarge(_))),
                        "{label} chunk {n}"
                    ),
                }
            }
        }
    }

    #[test]
    fn the_decoder_keeps_refusing_after_an_oversized_header_and_reads_the_cap_itself() {
        let mut decoder = FrameDecoder::new();
        assert!(decoder.push(&[1, 0]).unwrap().is_empty());
        assert!(decoder.push(&[0, 1]).is_err());
        assert!(decoder.push(b"more").is_err());
        let mut decoder = FrameDecoder::new();
        let mut stream = (MAX_FRAME_BYTES as u32).to_be_bytes().to_vec();
        stream.extend(std::iter::repeat_n(7u8, MAX_FRAME_BYTES));
        stream.extend_from_slice(&[0, 0, 0, 1, 9]);
        let frames = decoder.push(&stream).unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].len(), MAX_FRAME_BYTES);
        assert_eq!(frames[1], [9]);
    }

    #[test]
    fn sealed_frames_match_the_typescript_at_every_counter() {
        let sealed = captured();
        let sealed = &sealed["sealed"];
        let key = key(&sealed["key"]);
        let rows = sealed["rows"].as_array().unwrap();
        assert_eq!(rows.len() % 4, 0);
        for group in rows.chunks(4) {
            let start: u128 = group[0]["counter"].as_str().unwrap().parse().unwrap();
            let mut sealer = Sealer::at(&key, start);
            for row in group {
                let frame = sealer.seal(&unhex(row["plain"].as_str().unwrap()));
                assert_eq!(frame, unhex(row["frame"].as_str().unwrap()), "{row}");
            }
        }
        assert!(
            rows.iter()
                .any(|r| r["counter"] == "79228162514264337593543950335")
        );
        assert!(rows.iter().any(|r| r["counter"] == "18446744073709551616"));
    }

    #[test]
    #[should_panic(expected = "frame counter exhausted")]
    fn a_sealer_past_the_last_counter_stops_where_the_typescript_threw() {
        let mut sealer = Sealer::at(&[1; 32], (1u128 << 96) - 1);
        sealer.seal(b"last");
        sealer.seal(b"beyond");
    }

    #[test]
    fn a_fresh_sealer_counts_from_zero() {
        let mut sealer = Sealer::new(&[3; 32]);
        for expected in 0u128..3 {
            let frame = sealer.seal(b"x");
            assert_eq!(frame[..12], nonce(expected));
            assert_eq!(frame.len(), 12 + 1 + 16);
        }
    }

    #[test]
    fn the_opener_accepts_and_refuses_as_the_typescript_does() {
        let rows = captured();
        let rows = rows["opener"].as_array().unwrap();
        assert!(rows.len() >= 15);
        for row in rows {
            let label = row["name"].as_str().unwrap();
            let mut opener = Opener::new(&key(&row["key"]));
            for (n, step) in row["steps"].as_array().unwrap().iter().enumerate() {
                let got = opener.open(&unhex(step["frame"].as_str().unwrap()));
                if step["ok"].as_bool().unwrap() {
                    assert_eq!(
                        got.unwrap(),
                        unhex(step["plain"].as_str().unwrap()),
                        "{label} step {n}"
                    );
                } else {
                    assert!(got.is_err(), "{label} step {n}");
                }
            }
        }
    }

    #[test]
    fn the_opener_names_why_it_refused() {
        let mut sealer = Sealer::new(&[5; 32]);
        let mut opener = Opener::new(&[5; 32]);
        let first = sealer.seal(b"a");
        assert_eq!(opener.open(&first[..27]), Err(CodecError::Short));
        assert_eq!(opener.open(&first).unwrap(), b"a");
        assert_eq!(opener.open(&first), Err(CodecError::CounterNotIncreasing));
        let mut second = sealer.seal(b"b");
        let last = second.len() - 1;
        second[last] ^= 1;
        assert_eq!(opener.open(&second), Err(CodecError::Auth));
    }

    fn rows_of<'a>(streams: &'a Value, name: &str) -> &'a [Value] {
        streams[name].as_array().unwrap()
    }

    fn kind_of(body: &[u8]) -> &'static str {
        match body.first() {
            Some(0) => "deflated",
            Some(1) => "context",
            _ => "json",
        }
    }

    #[test]
    fn streams_the_typescript_sent_inflate_to_the_same_json_in_order() {
        let captured = captured();
        let streams = &captured["streams"];
        let key = key(&streams["keyAB"]);
        let mut seen = std::collections::BTreeSet::new();
        for name in ["context", "deflate", "none"] {
            let rows = rows_of(streams, name);
            let mut opener = Opener::new(&key);
            let mut sealer = Sealer::new(&key);
            let mut incoming = Incoming::new();
            for (n, row) in rows.iter().enumerate() {
                let frame = unb64(row["frame"].as_str().unwrap());
                let body = opener.open(&frame).unwrap();
                assert_eq!(
                    sealer.seal(&body),
                    frame,
                    "{name} {n}: sealing the same body"
                );
                assert_eq!(kind_of(&body), row["kind"].as_str().unwrap(), "{name} {n}");
                seen.insert((name, kind_of(&body)));
                let json = incoming
                    .json(&body, true)
                    .unwrap_or_else(|e| panic!("{name} {n}: {e}"));
                assert_eq!(
                    &*json,
                    row["json"].as_str().unwrap().as_bytes(),
                    "{name} {n}"
                );
                let t = message_type(&json).unwrap();
                assert!(!t.is_empty());
                assert_eq!(
                    matches!(json, Cow::Borrowed(_)),
                    body[0] > 1,
                    "{name} {n}: plain JSON is not copied"
                );
            }
            assert!(rows.len() >= if name == "none" { 3 } else { 19 }, "{name}");
        }
        assert!(rows_of(streams, "context").len() >= 40);
        for want in [
            ("context", "context"),
            ("context", "json"),
            ("deflate", "deflated"),
            ("deflate", "json"),
            ("none", "json"),
        ] {
            assert!(seen.contains(&want), "{want:?}");
        }
        assert!(!seen.contains(&("none", "deflated")) && !seen.contains(&("deflate", "context")));
    }

    #[test]
    fn what_a_peer_that_never_deflates_sends_is_json_whatever_its_size() {
        let mut outgoing = Outgoing::new();
        let json = vec![b'{'; 5000];
        let body = outgoing.body(&json).unwrap();
        assert!(matches!(body.bytes, Cow::Borrowed(_)) && !body.in_context);
    }

    /// The captured streams' messages through `Outgoing`, then back through a fresh `Incoming`.
    fn round_trip(name: &str, mode: Option<bool>) -> (usize, usize, usize) {
        let captured = captured();
        let streams = &captured["streams"];
        let rows = rows_of(streams, name);
        let mut outgoing = Outgoing::new();
        if let Some(context) = mode {
            outgoing.deflate(context);
        }
        let key = [9u8; 32];
        let (mut sealer, mut opener) = (Sealer::new(&key), Opener::new(&key));
        let mut incoming = Incoming::new();
        let (mut packed, mut plain, mut context) = (0, 0, 0);
        for (n, row) in rows.iter().enumerate() {
            let json = row["json"].as_str().unwrap().as_bytes();
            let body = outgoing.body(json).unwrap();
            let in_context = body.in_context;
            // Whether a message shrinks is zlib's to say, and the two zlibs agree on every message of these streams.
            let kind = if in_context {
                "context"
            } else if body.bytes.first() == Some(&0) {
                "deflated"
            } else {
                "json"
            };
            assert_eq!(kind, row["kind"].as_str().unwrap(), "{name} {n}");
            match (body.bytes.first(), in_context) {
                (Some(0), false) => packed += 1,
                (Some(1), true) => context += 1,
                (Some(0 | 1), _) => panic!("{name} {n}: marker and context disagree"),
                _ => plain += 1,
            }
            let frame = encode_frame(&sealer.seal(&body.bytes)).unwrap();
            if in_context {
                outgoing.commit(json);
            }
            let opened = opener.open(&frame[4..]).unwrap();
            let back = incoming
                .json(&opened, true)
                .unwrap_or_else(|e| panic!("{name} {n}: {e}"));
            assert_eq!(&*back, json, "{name} {n}");
        }
        (packed, plain, context)
    }

    #[test]
    fn streams_this_side_sends_inflate_on_this_side_in_every_mode() {
        let (packed, plain, context) = round_trip("context", Some(true));
        assert!(
            context >= 40 && plain >= 3 && packed == 0,
            "{packed} {plain} {context}"
        );
        let (packed, plain, context) = round_trip("deflate", Some(false));
        assert!(
            packed >= 6 && plain >= 12 && context == 0,
            "{packed} {plain} {context}"
        );
        let (packed, plain, context) = round_trip("none", None);
        assert_eq!((packed, plain, context), (0, 3, 0));
    }

    #[test]
    fn deflate_decisions_follow_the_thresholds() {
        let message = |len: usize| {
            let mut json = br#"{"t":"x","p":""#.to_vec();
            json.resize(len - 2, b'a');
            json.extend_from_slice(b"\"}");
            json
        };
        let mut plain = Outgoing::new();
        plain.deflate(false);
        for (len, deflated) in [
            (63, false),
            (64, false),
            (1023, false),
            (1024, true),
            (5000, true),
        ] {
            let json = message(len);
            assert_eq!(
                plain.body(&json).unwrap().bytes.first() == Some(&0),
                deflated,
                "plain {len}"
            );
        }
        let mut context = Outgoing::new();
        context.deflate(true);
        for (len, deflated) in [(63, false), (64, true), (65, true), (1024, true)] {
            let json = message(len);
            let body = context.body(&json).unwrap();
            assert_eq!(body.bytes.first() == Some(&1), deflated, "context {len}");
            assert_eq!(body.in_context, deflated, "context {len}");
        }
    }

    #[test]
    fn a_message_that_does_not_shrink_crosses_as_json_and_stays_out_of_the_context() {
        let mut outgoing = Outgoing::new();
        outgoing.deflate(true);
        let mut random = 0x1234_5678u32;
        let mut json = br#"{"t":"x","p":""#.to_vec();
        while json.len() < 3000 {
            random = random.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            // Every byte value: a text alphabet still shrinks under Huffman coding.
            json.push((random >> 24) as u8);
        }
        json.extend_from_slice(b"\"}");
        let body = outgoing.body(&json).unwrap();
        assert!(matches!(body.bytes, Cow::Borrowed(_)));
        assert!(!body.in_context);
    }

    #[test]
    fn a_message_past_the_cap_is_refused_before_any_deflate() {
        let mut outgoing = Outgoing::new();
        outgoing.deflate(true);
        let json = vec![b'a'; MAX_FRAME_BYTES + 1];
        assert_eq!(
            outgoing.body(&json).err(),
            Some(CodecError::FrameTooLarge(MAX_FRAME_BYTES + 1))
        );
        let json = vec![b'a'; MAX_FRAME_BYTES];
        assert!(outgoing.body(&json).is_ok());
    }

    #[test]
    fn a_message_that_was_not_written_does_not_join_the_context() {
        let message = |tag: &str| {
            format!(
                r#"{{"t":"x","p":"{}"}}"#,
                format!("{tag} line of text that repeats ").repeat(20)
            )
            .into_bytes()
        };
        let (first, second) = (message("one"), message("two"));
        let mut a = Outgoing::new();
        a.deflate(true);
        let mut b = Outgoing::new();
        b.deflate(true);
        // `a` writes the first and commits; `b` composes it too but the write fails, so it never commits.
        let wrote = a.body(&first).unwrap().bytes.into_owned();
        a.commit(&first);
        assert_eq!(b.body(&first).unwrap().bytes.into_owned(), wrote);
        let with = a.body(&second).unwrap().bytes.into_owned();
        let without = b.body(&second).unwrap().bytes.into_owned();
        assert_ne!(
            with, without,
            "the second message is deflated against the first only after a commit"
        );
        // The peer that received the first holds a context that reads `with`, not `without`.
        let mut peer = Incoming::new();
        peer.json(&wrote, true).unwrap();
        assert_eq!(&*peer.json(&with, true).unwrap(), &second[..]);
    }

    #[test]
    fn the_context_is_the_last_32_kib_however_it_was_appended() {
        let mut context = Context::default();
        let mut model: Vec<u8> = Vec::new();
        let mut random = 7u32;
        let mut next = || {
            random = random.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            random >> 8
        };
        for _ in 0..400 {
            let len = match next() % 5 {
                0 => (next() % 40) as usize,
                1 => CONTEXT_BYTES - 1 + (next() % 3) as usize,
                2 => (next() % 70_000) as usize,
                _ => (next() % 9_000) as usize,
            };
            let chunk: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            context.append(&chunk);
            model.extend_from_slice(&chunk);
            let want = &model[model.len().saturating_sub(CONTEXT_BYTES)..];
            match context.dictionary() {
                None => assert!(model.is_empty()),
                Some(got) => assert_eq!(got, want),
            }
            assert!(context.bytes.len() <= 2 * CONTEXT_BYTES + CONTEXT_BYTES);
        }
    }

    fn deliver(incoming: &mut Incoming, body: &[u8], secure: bool) -> Result<String, CodecError> {
        let json = incoming.json(body, secure)?;
        message_type(&json)
    }

    #[test]
    fn what_a_receiving_link_accepts_is_what_the_typescript_accepted() {
        let captured = captured();
        let rows = captured["receiver"].as_array().unwrap();
        assert!(rows.len() >= 190, "{}", rows.len());
        for row in rows {
            let label = row["name"].as_str().unwrap();
            let secure = row["secure"].as_bool().unwrap();
            let delivered = row["delivered"].as_array().unwrap();
            let closed = !row["closed"].is_null();
            let mut incoming = Incoming::new();
            let mut got = Vec::new();
            let mut failed = false;
            for body in row["bodies"].as_array().unwrap() {
                match deliver(&mut incoming, &unb64(body.as_str().unwrap()), secure) {
                    Ok(t) => got.push(t),
                    Err(_) => {
                        failed = true;
                        break;
                    }
                }
            }
            assert_eq!(failed, closed, "{label}");
            let want: Vec<String> = delivered.iter().map(units).collect();
            assert_eq!(got, want, "{label}");
        }
    }

    #[test]
    fn nesting_as_deep_as_node_reads_is_read_and_unbalanced_nesting_is_not() {
        for row in captured()["deep"].as_array().unwrap() {
            let depth = row["depth"].as_str().unwrap();
            let json = match row["name"].as_str().unwrap() {
                "arrays 100000" | "arrays 1000000" => {
                    let n: usize = depth.parse().unwrap();
                    format!(r#"{{"t":"deep","d":{}{}}}"#, "[".repeat(n), "]".repeat(n))
                }
                "arrays unbalanced" => format!(
                    r#"{{"t":"deep","d":{}{}}}"#,
                    "[".repeat(100_000),
                    "]".repeat(99_999)
                ),
                "objects 50000" => format!(
                    r#"{{"t":"deep","d":{}1{}}}"#,
                    r#"{"a":"#.repeat(50_000),
                    "}".repeat(50_000)
                ),
                other => panic!("{other}"),
            };
            assert_eq!(
                message_type(json.as_bytes()).is_ok(),
                row["ok"].as_bool().unwrap(),
                "{}",
                row["name"]
            );
        }
    }

    #[test]
    fn message_type_reads_the_type_node_would() {
        for (json, want) in [
            (&br#"{"t":"a"}"#[..], Some("a")),
            (br#"{"u":1,"t":"b","v":[{"t":5}]}"#, Some("b")),
            (br#"{"a":{"t":5},"t":"c"}"#, Some("c")),
            (br#"{"t":"x","t":"y"}"#, Some("y")),
            (br#"{"t":"x","t":1}"#, None),
            (br#"{"t":1,"t":"y"}"#, Some("y")),
            (br#"{"\u0074":"e"}"#, Some("e")),
            (br#"{"t":"\ud800"}"#, Some("\u{fffd}")),
            (b"{\"t\":\"a\xffb\"}", Some("a\u{fffd}b")),
            (br#"[{"t":"a"}]"#, None),
            (b"", None),
        ] {
            assert_eq!(
                message_type(json).ok().as_deref(),
                want,
                "{}",
                String::from_utf8_lossy(json)
            );
        }
        assert_eq!(message_type(b"[]"), Err(CodecError::NotObject));
        assert_eq!(message_type(b"{}"), Err(CodecError::NoType));
        assert_eq!(message_type(b"{"), Err(CodecError::NotJson));
    }

    #[test]
    fn the_reader_never_panics_on_any_bytes() {
        let mut random = 99u32;
        let mut next = || {
            random = random.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (random >> 16) as usize
        };
        let alphabet: &[u8] = b"{}[]\":,\\u0123456789-+.eEtrufalsn \t\xff\xe2\x82ab/";
        for _ in 0..4000 {
            let len = next() % 40;
            let text: Vec<u8> = (0..len)
                .map(|_| alphabet[next() % alphabet.len()])
                .collect();
            let _ = message_type(&text);
            if let Some(value) = scan::Value::root(&text) {
                for (_, entry) in value.entries() {
                    let _ = (
                        entry.string(),
                        entry.number(),
                        entry.items().count(),
                        entry.entries().count(),
                    );
                }
                let _ = (value.get("t"), value.items().count());
            }
        }
    }
}
