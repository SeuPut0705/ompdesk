//! `/blob/<token>`: what a page fetches instead of receiving it in a WebSocket frame (a file the viewer shows, a
//! recording a player streams, a download; unit 8b, was `src/main/web/blobs.ts`). Each token is random, belongs to
//! one device (its cookie must match) and dies after 30 minutes without a request. The three sources: a file on disk,
//! bytes main already holds, or a stream only the shell can open (an `omp-media://` address). Answers
//! honour `Range`. A blob is never rendered as a page: HTML, SVG and scripts are served as attachments, everything
//! carries `nosniff` and a sandboxing CSP.
//!
//! One store per `userData` per core process (`open`), shared with the edge, which serves it (`Blobs::serve`). Main
//! mints a token (24 random bytes, base64url) and registers it with an ordered push, so it can hand the URL back at
//! once: the page only learns it from a frame that is written after the push.
//!
//! Pushes (`register`): `web.blobs.add` `{userData, deviceId, token, kind: "file" | "bytes" | "media", mime, name,
//! download?, abs?, url?, now}` (a `bytes` blob's bytes are the `bin`), `web.blobs.releaseDevice` `{userData,
//! deviceId}`. Methods: `web.blobs.release` `{userData, deviceId, url}` -> `{released}`, `web.blobs.mediaUrl`
//! `{userData, deviceId, url, now}` -> `{url}`, `web.blobs.count` `{userData}` -> `{size}`, and `web.blobs.serve`
//! `{userData, deviceId, target, method, range?, now}` -> `{status, headers: [[name, value]]}` + the body as `bin`
//! (what the edge's `serve` writes, whole; for the parity tests).
//!
//! A media blob's bytes come from main: the event `web.media.open` `{userData, stream, token, url, range}` asks, main
//! answers with the pushes `web.media.head` `{stream, status, headers}` (headers: an object of `content-type`,
//! `content-length`, `content-range`, `accept-ranges`), `web.media.chunk` `{stream}` + `bin` and `web.media.end`
//! `{stream, error?}`. The core grants a window: main sends no more than a megabyte beyond what `web.media.ack`
//! `{stream, bytes}` reported consumed, and stops the stream on `web.media.cancel` `{stream}` (the client went). The
//! event `web.media.drop` `{userData, token}` says an entry is gone (released, expired, pushed out).

use std::collections::HashMap;
use std::fs;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderName, HeaderValue, RANGE};
use hyper::{Method, Request, Response, StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::body::Out;
use super::deps::{Blobs, BoxFuture};
use crate::server::{Call, Events, Fault, PushCall, Registry, Reply as WireReply};

pub const URL_PREFIX: &str = "/blob/";
pub const IDLE_TTL_MS: i64 = 30 * 60_000;
const MAX_PER_DEVICE: usize = 64;
/// How much of a file one chunk carries.
const CHUNK: usize = 64 * 1024;

/// The headers of a media answer that are copied from main's.
const MEDIA_HEADERS: [&str; 4] = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
];

/// Types a browser would run or render as a document: only ever downloaded (`^(text/html|…)\b`, case-insensitive).
fn is_active_content(mime: &str) -> bool {
    const TYPES: [&str; 9] = [
        "text/html",
        "application/xhtml+xml",
        "image/svg+xml",
        "text/xml",
        "application/xml",
        "text/javascript",
        "text/x-javascript",
        "application/javascript",
        "application/x-javascript",
    ];
    let lower = mime.to_ascii_lowercase();
    TYPES.iter().any(|kind| {
        lower.strip_prefix(kind).is_some_and(|rest| {
            !rest
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        })
    })
}

/// A single `bytes=` range of a `size`-byte body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Range {
    /// No range was asked for.
    Whole,
    /// It cannot be met (416).
    Invalid,
    /// `start..=end`; `end` is -1 for a suffix of an empty body, as the TypeScript's arithmetic gave.
    Bytes { start: i64, end: i64 },
}

/// `parseRange`: a range, `Whole` for none given, `Invalid` when it cannot be met.
pub fn parse_range(header: Option<&str>, size: u64) -> Range {
    let Some(header) = header.filter(|header| !header.is_empty()) else {
        return Range::Whole;
    };
    let trimmed =
        header.trim_matches(|ch: char| (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}');
    let Some((from, to)) = trimmed
        .strip_prefix("bytes=")
        .and_then(|spec| spec.split_once('-'))
    else {
        return Range::Invalid;
    };
    let digits = |text: &str| text.bytes().all(|byte| byte.is_ascii_digit());
    if !digits(from) || !digits(to) || (from.is_empty() && to.is_empty()) {
        return Range::Invalid;
    }
    // `Number(digits)`: a double, so a 30-digit offset is a huge number and not a failure.
    let number = |text: &str| text.parse::<f64>().unwrap_or(0.0);
    let size_number = size as f64;
    if from.is_empty() {
        let suffix = number(to);
        if suffix == 0.0 {
            return Range::Invalid;
        }
        return Range::Bytes {
            start: (size_number - suffix).max(0.0) as i64,
            end: size as i64 - 1,
        };
    }
    let start = number(from);
    let end = if to.is_empty() {
        size_number - 1.0
    } else {
        number(to).min(size_number - 1.0)
    };
    if start >= size_number || start > end {
        return Range::Invalid;
    }
    Range::Bytes {
        start: start as i64,
        end: end as i64,
    }
}

/// `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn content_disposition(name: &str, attachment: bool) -> String {
    // Per UTF-16 unit, as the regex read it: a character past U+FFFF becomes two.
    let ascii: String = name
        .chars()
        .flat_map(|ch| {
            let keep = (' '..='~').contains(&ch) && ch != '"' && ch != '\\';
            std::iter::repeat_n(if keep { ch } else { '_' }, ch.len_utf16())
        })
        .collect();
    format!(
        "{}; filename=\"{ascii}\"; filename*=UTF-8''{}",
        if attachment { "attachment" } else { "inline" },
        encode_uri_component(name)
    )
}

/// The token of `/blob/<token>[?query]`, or None.
fn token_of(blob_url: &str) -> Option<&str> {
    let rest = blob_url.strip_prefix(URL_PREFIX)?;
    let token = rest.split(['?', '#']).next()?;
    (!token.is_empty()
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'))
    .then_some(token)
}

/// Whether the URL's query says `dl=1` (`new URL(url).searchParams.get("dl") === "1"`).
fn wants_download(blob_url: &str) -> bool {
    let query = blob_url
        .split_once('#')
        .map_or(blob_url, |(before, _)| before)
        .split_once('?')
        .map_or("", |(_, query)| query);
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "dl")
        .is_some_and(|(_, value)| value == "1")
}

#[derive(Debug, Clone)]
pub enum Source {
    File(PathBuf),
    Bytes(Bytes),
    /// A stream main serves, by its `omp-media://` address.
    Media(String),
}

struct Entry {
    /// Insertion order, which settles which of two blobs added in the same millisecond is the oldest.
    seq: u64,
    device: String,
    source: Source,
    mime: String,
    name: String,
    download: bool,
    touched_at: i64,
}

/// A blob to register.
pub struct NewBlob<'a> {
    pub device: &'a str,
    pub source: Source,
    pub mime: &'a str,
    pub name: &'a str,
    pub download: bool,
}

/// What a media stream answers with: the status, the headers of `MEDIA_HEADERS`, the bytes as they come.
pub struct MediaAnswer {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: mpsc::Receiver<Bytes>,
}

/// Opens the media stream behind a blob (main's `mediaResponse` over the shell's `boot.mediaHead`/`mediaRead`).
pub trait MediaOpener: Send + Sync {
    /// `None` when the stream cannot be opened (the page is told 404).
    fn open<'a>(
        &'a self,
        token: &'a str,
        url: &'a str,
        range: Option<&'a str>,
    ) -> BoxFuture<'a, Option<MediaAnswer>>;
}

#[derive(Default)]
struct State {
    entries: HashMap<String, Entry>,
    next_seq: u64,
    events: Option<Events>,
    opener: Option<Arc<dyn MediaOpener>>,
}

pub struct BlobStore {
    user_data: String,
    ttl_ms: i64,
    state: Mutex<State>,
}

static STORES: LazyLock<Mutex<HashMap<PathBuf, Arc<BlobStore>>>> = LazyLock::new(Mutex::default);

/// The one store of this `userData` in the process.
pub fn open(user_data: &Path) -> Arc<BlobStore> {
    let mut stores = STORES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(stores.entry(user_data.to_path_buf()).or_insert_with(|| {
        Arc::new(BlobStore::new(
            user_data.to_string_lossy().into_owned(),
            IDLE_TTL_MS,
        ))
    }))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

/// A header list in the order it is written; setting a name that is there keeps its place.
type Headers = Vec<(String, String)>;

fn set(headers: &mut Headers, name: &str, value: String) {
    match headers.iter_mut().find(|(have, _)| have == name) {
        Some(slot) => slot.1 = value,
        None => headers.push((name.to_owned(), value)),
    }
}

pub enum Payload {
    /// Written with the length it has.
    Sized(Bytes),
    /// A `writeHead` without a length that ends at once: chunked.
    Chunked,
    /// `length` bytes when the headers say so.
    Stream {
        chunks: mpsc::Receiver<Bytes>,
        length: Option<u64>,
    },
}

/// A blob's answer before it becomes a hyper response.
pub struct Answer {
    pub status: u16,
    pub headers: Headers,
    pub body: Payload,
}

impl Answer {
    fn fail(status: u16) -> Answer {
        Answer {
            status,
            headers: vec![
                ("content-type".to_owned(), "text/plain".to_owned()),
                ("cache-control".to_owned(), "no-store".to_owned()),
            ],
            body: Payload::Chunked,
        }
    }

    /// The hyper response; an answer hyper cannot write (a header with a byte HTTP refuses) is the 404.
    pub fn into_response(self) -> Response<Out> {
        let Self {
            status,
            headers,
            body,
        } = self;
        let mut builder = Response::builder()
            .status(StatusCode::from_u16(status).unwrap_or(StatusCode::NOT_FOUND));
        if let Some(map) = builder.headers_mut() {
            for (name, value) in &headers {
                match (
                    HeaderName::from_bytes(name.as_bytes()),
                    HeaderValue::from_str(value),
                ) {
                    (Ok(name), Ok(value)) => {
                        map.append(name, value);
                    }
                    _ => return Answer::fail(404).into_response(),
                }
            }
        }
        let body = match body {
            Payload::Sized(bytes) => Out::sized(bytes),
            Payload::Chunked => Out::chunked(Bytes::new()),
            Payload::Stream { chunks, length } => Out::stream(chunks, length),
        };
        builder
            .body(body)
            .unwrap_or_else(|_| Response::new(Out::empty()))
    }

    /// The body gathered whole.
    async fn collect(self) -> (u16, Headers, Vec<u8>) {
        let bytes = match self.body {
            Payload::Sized(bytes) => bytes.to_vec(),
            Payload::Chunked => Vec::new(),
            Payload::Stream { mut chunks, .. } => {
                let mut all = Vec::new();
                while let Some(chunk) = chunks.recv().await {
                    all.extend_from_slice(&chunk);
                }
                all
            }
        };
        (self.status, self.headers, bytes)
    }
}

impl BlobStore {
    pub fn new(user_data: String, ttl_ms: i64) -> Self {
        Self {
            user_data,
            ttl_ms,
            state: Mutex::default(),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Where `web.media.drop` goes: set by the first request that carries an `Events`.
    pub fn attach_events(&self, events: Events) {
        self.state().events.get_or_insert(events);
    }

    /// Opens media streams with `opener` instead of asking main (a test's).
    pub fn set_media_opener(&self, opener: Arc<dyn MediaOpener>) {
        self.state().opener = Some(opener);
    }

    pub fn count(&self) -> usize {
        self.state().entries.len()
    }

    fn forget(&self, state: &mut State, token: &str) -> Option<Entry> {
        let entry = state.entries.remove(token)?;
        if matches!(entry.source, Source::Media(_))
            && let Some(events) = &state.events
        {
            events.send(
                "web.media.drop",
                &json!({ "userData": self.user_data, "token": token }),
            );
        }
        Some(entry)
    }

    /// Register a blob under a token main minted.
    pub fn add(&self, now: i64, token: &str, blob: NewBlob<'_>) {
        let NewBlob {
            device,
            source,
            mime,
            name,
            download,
        } = blob;
        if token_of(&format!("{URL_PREFIX}{token}")) != Some(token) {
            return;
        }
        let mut state = self.state();
        let expired: Vec<String> = state
            .entries
            .iter()
            .filter(|(_, entry)| now - entry.touched_at > self.ttl_ms)
            .map(|(token, _)| token.clone())
            .collect();
        for token in expired {
            self.forget(&mut state, &token);
        }
        let mine: Vec<(&String, &Entry)> = state
            .entries
            .iter()
            .filter(|(_, entry)| entry.device == device)
            .collect();
        if mine.len() >= MAX_PER_DEVICE
            && let Some(oldest) = mine
                .into_iter()
                .min_by_key(|(_, entry)| (entry.touched_at, entry.seq))
                .map(|(token, _)| token.clone())
        {
            self.forget(&mut state, &oldest);
        }
        state.next_seq += 1;
        let seq = state.next_seq;
        state.entries.insert(
            token.to_owned(),
            Entry {
                seq,
                device: device.to_owned(),
                source,
                mime: mime.to_owned(),
                name: name.to_owned(),
                download,
                touched_at: now,
            },
        );
    }

    /// The entry of this device's token, kept alive by the request; an expired one goes.
    fn lookup(
        &self,
        state: &mut State,
        now: i64,
        device: &str,
        token: Option<&str>,
    ) -> Option<String> {
        let token = token?;
        let entry = state.entries.get_mut(token)?;
        if entry.device != device {
            return None;
        }
        if now - entry.touched_at > self.ttl_ms {
            self.forget(state, token);
            return None;
        }
        entry.touched_at = now;
        Some(token.to_owned())
    }

    /// The `omp-media://` address behind a blob URL of this device, or None.
    pub fn media_url(&self, now: i64, device: &str, blob_url: &str) -> Option<String> {
        let mut state = self.state();
        let token = self.lookup(&mut state, now, device, token_of(blob_url))?;
        match &state.entries.get(&token)?.source {
            Source::Media(url) => Some(url.clone()),
            _ => None,
        }
    }

    pub fn release(&self, device: &str, blob_url: &str) -> bool {
        let Some(token) = token_of(blob_url) else {
            return false;
        };
        let mut state = self.state();
        if state
            .entries
            .get(token)
            .is_none_or(|entry| entry.device != device)
        {
            return false;
        }
        self.forget(&mut state, token).is_some()
    }

    pub fn release_device(&self, device: &str) {
        let mut state = self.state();
        let mine: Vec<String> = state
            .entries
            .iter()
            .filter(|(_, entry)| entry.device == device)
            .map(|(token, _)| token.clone())
            .collect();
        for token in mine {
            self.forget(&mut state, &token);
        }
    }

    fn opener(&self, state: &State) -> Option<Arc<dyn MediaOpener>> {
        if let Some(opener) = &state.opener {
            return Some(Arc::clone(opener));
        }
        state.events.clone().map(|events| {
            Arc::new(MainMedia {
                events,
                user_data: self.user_data.clone(),
            }) as Arc<dyn MediaOpener>
        })
    }

    /// The whole answer for `GET`/`HEAD /blob/<token>` of the authenticated `device`.
    pub async fn answer(
        &self,
        now: i64,
        device: &str,
        blob_url: &str,
        method: &Method,
        range: Option<&str>,
    ) -> Answer {
        let (token, snapshot, opener) = {
            let mut state = self.state();
            let Some(token) = self.lookup(&mut state, now, device, token_of(blob_url)) else {
                return Answer::fail(404);
            };
            let Some(entry) = state.entries.get(&token) else {
                return Answer::fail(404);
            };
            let snapshot = (
                entry.source.clone(),
                entry.mime.clone(),
                entry.name.clone(),
                entry.download,
            );
            let opener = matches!(entry.source, Source::Media(_))
                .then(|| self.opener(&state))
                .flatten();
            (token, snapshot, opener)
        };
        let (source, mime, name, download) = snapshot;
        let attachment = download || wants_download(blob_url) || is_active_content(&mime);
        let base: Headers = vec![
            ("content-type".to_owned(), mime),
            ("accept-ranges".to_owned(), "bytes".to_owned()),
            (
                "content-disposition".to_owned(),
                content_disposition(&name, attachment),
            ),
            ("x-content-type-options".to_owned(), "nosniff".to_owned()),
            ("cache-control".to_owned(), "private, no-store".to_owned()),
            (
                "content-security-policy".to_owned(),
                "sandbox; default-src 'none'".to_owned(),
            ),
            (
                "cross-origin-resource-policy".to_owned(),
                "same-origin".to_owned(),
            ),
        ];
        let head = method == Method::HEAD;
        match source {
            Source::Media(url) => match opener {
                Some(opener) => serve_media(opener.as_ref(), &token, &url, base, head, range).await,
                None => Answer::fail(404),
            },
            Source::Bytes(bytes) => serve_bytes(&bytes, base, head, range),
            Source::File(abs) => serve_file(abs, base, head, range).await,
        }
    }
}

/// The status line and headers of a 200 or 206 over a `size`-byte body.
fn head_of(mut base: Headers, size: u64, range: Range) -> (u16, Headers) {
    match range {
        Range::Bytes { start, end } => {
            base.push(("content-length".to_owned(), (end - start + 1).to_string()));
            base.push((
                "content-range".to_owned(),
                format!("bytes {start}-{end}/{size}"),
            ));
            (206, base)
        }
        _ => {
            base.push(("content-length".to_owned(), size.to_string()));
            (200, base)
        }
    }
}

fn unsatisfiable(mut base: Headers, size: u64) -> Answer {
    base.push(("content-range".to_owned(), format!("bytes */{size}")));
    Answer {
        status: 416,
        headers: base,
        body: Payload::Chunked,
    }
}

fn serve_bytes(bytes: &Bytes, base: Headers, head: bool, range: Option<&str>) -> Answer {
    let range = parse_range(range, bytes.len() as u64);
    if range == Range::Invalid {
        return unsatisfiable(base, bytes.len() as u64);
    }
    let (status, headers) = head_of(base, bytes.len() as u64, range);
    let body = match range {
        _ if head => Bytes::new(),
        Range::Bytes { start, end } => bytes.slice(start as usize..(end + 1) as usize),
        _ => bytes.clone(),
    };
    Answer {
        status,
        headers,
        body: Payload::Sized(body),
    }
}

async fn serve_file(abs: PathBuf, base: Headers, head: bool, range: Option<&str>) -> Answer {
    let opened = tokio::task::spawn_blocking(move || {
        let file = fs::File::open(&abs).ok()?;
        let info = file.metadata().ok()?;
        info.is_file().then_some((file, info.len()))
    })
    .await
    .ok()
    .flatten();
    let Some((mut file, size)) = opened else {
        return Answer::fail(404);
    };
    let range = parse_range(range, size);
    if range == Range::Invalid {
        return unsatisfiable(base, size);
    }
    let (status, headers) = head_of(base, size, range);
    let (start, length) = match range {
        Range::Bytes { start, end } => (start as u64, (end - start + 1) as u64),
        _ => (0, size),
    };
    if head || size == 0 {
        return Answer {
            status,
            headers,
            body: Payload::Sized(Bytes::new()),
        };
    }
    let (sender, chunks) = mpsc::channel(4);
    tokio::task::spawn_blocking(move || {
        if start > 0 && file.seek(SeekFrom::Start(start)).is_err() {
            return;
        }
        let mut left = length;
        while left > 0 {
            let mut buffer = vec![0; left.min(CHUNK as u64) as usize];
            match file.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    buffer.truncate(read);
                    left -= read as u64;
                    // The client went: nobody takes the rest.
                    if sender.blocking_send(Bytes::from(buffer)).is_err() {
                        break;
                    }
                }
            }
        }
    });
    Answer {
        status,
        headers,
        body: Payload::Stream {
            chunks,
            length: Some(length),
        },
    }
}

async fn serve_media(
    opener: &dyn MediaOpener,
    token: &str,
    url: &str,
    mut headers: Headers,
    head: bool,
    range: Option<&str>,
) -> Answer {
    let Some(answer) = opener.open(token, url, range).await else {
        return Answer::fail(404);
    };
    if !(100..=999).contains(&answer.status) || StatusCode::from_u16(answer.status).is_err() {
        return Answer::fail(404);
    }
    for name in MEDIA_HEADERS {
        if let Some((_, value)) = answer
            .headers
            .iter()
            .find(|(have, value)| have == name && !value.is_empty())
        {
            set(&mut headers, name, value.clone());
        }
    }
    if head {
        // The answer's body is dropped unread: main is told to stop.
        return Answer {
            status: answer.status,
            headers,
            body: Payload::Sized(Bytes::new()),
        };
    }
    let length = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .and_then(|(_, value)| value.parse::<u64>().ok());
    Answer {
        status: answer.status,
        headers,
        body: Payload::Stream {
            chunks: answer.body,
            length,
        },
    }
}

impl Blobs for BlobStore {
    fn serve(
        &self,
        device_id: &str,
        target: &str,
        request: Request<Incoming>,
    ) -> BoxFuture<'_, Response<Out>> {
        let (device, target) = (device_id.to_owned(), target.to_owned());
        let method = request.method().clone();
        let range = range_header(&request);
        Box::pin(async move {
            self.answer(now_ms(), &device, &target, &method, range.as_deref())
                .await
                .into_response()
        })
    }
}

/// The request's `Range` header as one string, a repeated one joined as node joins it.
fn range_header(request: &Request<Incoming>) -> Option<String> {
    let values: Vec<String> = request
        .headers()
        .get_all(RANGE)
        .iter()
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}

// ---- the media streams main opens ----

enum Message {
    Head { status: u16, headers: Headers },
    Chunk(Bytes),
    End,
}

static STREAMS: LazyLock<Mutex<HashMap<u64, mpsc::UnboundedSender<Message>>>> =
    LazyLock::new(Mutex::default);
static NEXT_STREAM: AtomicU64 = AtomicU64::new(1);

fn streams() -> MutexGuard<'static, HashMap<u64, mpsc::UnboundedSender<Message>>> {
    STREAMS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A media stream main was asked to open: gone from the table when dropped, and main told to stop unless it ended.
struct OpenStream {
    id: u64,
    events: Events,
    ended: bool,
}

impl OpenStream {
    /// Main ended the stream by itself: nothing to cancel.
    fn finish(mut self) {
        self.ended = true;
    }
}

impl Drop for OpenStream {
    fn drop(&mut self) {
        streams().remove(&self.id);
        if !self.ended {
            self.events
                .send("web.media.cancel", &json!({ "stream": self.id }));
        }
    }
}

struct MainMedia {
    events: Events,
    user_data: String,
}

impl MediaOpener for MainMedia {
    fn open<'a>(
        &'a self,
        token: &'a str,
        url: &'a str,
        range: Option<&'a str>,
    ) -> BoxFuture<'a, Option<MediaAnswer>> {
        Box::pin(async move {
            let id = NEXT_STREAM.fetch_add(1, Ordering::Relaxed);
            let (messages, mut incoming) = mpsc::unbounded_channel();
            streams().insert(id, messages);
            let stream = OpenStream {
                id,
                events: self.events.clone(),
                ended: false,
            };
            self.events.send(
                "web.media.open",
                &json!({
                    "userData": self.user_data,
                    "stream": id,
                    "token": token,
                    "url": url,
                    "range": range,
                }),
            );
            let (status, headers) = loop {
                match incoming.recv().await? {
                    Message::Head { status, headers } => break (status, headers),
                    Message::End => {
                        stream.finish();
                        return None;
                    }
                    Message::Chunk(_) => {}
                }
            };
            let (sender, body) = mpsc::channel(4);
            let events = self.events.clone();
            tokio::spawn(async move {
                loop {
                    let message = tokio::select! {
                        // The client went before main sent anything more.
                        () = sender.closed() => return,
                        message = incoming.recv() => match message {
                            Some(message) => message,
                            None => return,
                        },
                    };
                    match message {
                        Message::Chunk(chunk) => {
                            let bytes = chunk.len();
                            if sender.send(chunk).await.is_err() {
                                // The client went; dropping `stream` tells main.
                                return;
                            }
                            events.send("web.media.ack", &json!({ "stream": id, "bytes": bytes }));
                        }
                        Message::End => {
                            stream.finish();
                            return;
                        }
                        Message::Head { .. } => {}
                    }
                }
            });
            Some(MediaAnswer {
                status,
                headers,
                body,
            })
        })
    }
}

fn deliver(id: u64, message: Message) {
    if let Some(stream) = streams().get(&id) {
        let _ = stream.send(message);
    }
}

#[derive(Deserialize)]
struct StreamParams {
    stream: u64,
    #[serde(default)]
    status: u16,
    #[serde(default)]
    headers: serde_json::Map<String, Value>,
}

fn media_head(push: PushCall) {
    let Ok(params) = serde_json::from_str::<StreamParams>(push.params.get()) else {
        return;
    };
    let headers = MEDIA_HEADERS
        .iter()
        .filter_map(|name| {
            params
                .headers
                .get(*name)
                .and_then(Value::as_str)
                .map(|value| ((*name).to_owned(), value.to_owned()))
        })
        .collect();
    deliver(
        params.stream,
        Message::Head {
            status: params.status,
            headers,
        },
    );
}

fn media_chunk(push: PushCall) {
    let Ok(params) = serde_json::from_str::<StreamParams>(push.params.get()) else {
        return;
    };
    if let Some(bin) = push.bin {
        deliver(params.stream, Message::Chunk(Bytes::from(bin)));
    }
}

fn media_end(push: PushCall) {
    if let Ok(params) = serde_json::from_str::<StreamParams>(push.params.get()) {
        deliver(params.stream, Message::End);
    }
}

// ---- the methods ----

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    File,
    Bytes,
    Media,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddParams {
    user_data: PathBuf,
    device_id: String,
    token: String,
    kind: Kind,
    mime: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    download: bool,
    abs: Option<PathBuf>,
    url: Option<String>,
    now: i64,
}

fn add(push: PushCall) {
    let Ok(params) = serde_json::from_str::<AddParams>(push.params.get()) else {
        return;
    };
    let source = match (params.kind, params.abs, params.url, push.bin) {
        (Kind::File, Some(abs), _, _) => Source::File(abs),
        (Kind::Bytes, _, _, bin) => Source::Bytes(Bytes::from(bin.unwrap_or_default())),
        (Kind::Media, _, Some(url), _) => Source::Media(url),
        _ => return,
    };
    let store = open(&params.user_data);
    store.attach_events(push.events);
    store.add(
        params.now,
        &params.token,
        NewBlob {
            device: &params.device_id,
            source,
            mime: &params.mime,
            name: &params.name,
            download: params.download,
        },
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceParams {
    user_data: PathBuf,
    #[serde(default)]
    device_id: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    range: Option<String>,
    #[serde(default)]
    now: Option<i64>,
}

fn release_device(push: PushCall) {
    if let Ok(params) = serde_json::from_str::<DeviceParams>(push.params.get()) {
        let store = open(&params.user_data);
        store.attach_events(push.events);
        store.release_device(&params.device_id);
    }
}

fn store_of(call: &Call) -> Result<(DeviceParams, Arc<BlobStore>), Fault> {
    let params: DeviceParams = call.params()?;
    let store = open(&params.user_data);
    store.attach_events(call.events.clone());
    Ok((params, store))
}

async fn release(call: Call) -> Result<WireReply, Fault> {
    let (params, store) = store_of(&call)?;
    WireReply::json(&json!({ "released": store.release(&params.device_id, &params.url) }))
}

async fn media_url(call: Call) -> Result<WireReply, Fault> {
    let (params, store) = store_of(&call)?;
    let now = params.now.unwrap_or_else(now_ms);
    WireReply::json(&json!({ "url": store.media_url(now, &params.device_id, &params.url) }))
}

async fn count(call: Call) -> Result<WireReply, Fault> {
    let (_, store) = store_of(&call)?;
    WireReply::json(&json!({ "size": store.count() }))
}

async fn serve(call: Call) -> Result<WireReply, Fault> {
    let (params, store) = store_of(&call)?;
    let method = params
        .method
        .as_deref()
        .map_or(Ok(Method::GET), |method| {
            Method::from_bytes(method.as_bytes())
        })
        .map_err(|_| Fault::new("invalid_params", "method is not an HTTP method"))?;
    let answer = store
        .answer(
            params.now.unwrap_or_else(now_ms),
            &params.device_id,
            &params.target,
            &method,
            params.range.as_deref(),
        )
        .await;
    let (status, headers, body) = answer.collect().await;
    let headers: Vec<[String; 2]> = headers
        .into_iter()
        .map(|(name, value)| [name, value])
        .collect();
    Ok(WireReply::json(&json!({ "status": status, "headers": headers }))?.with_bin(body))
}

pub fn register(registry: &mut Registry) {
    registry.add_push("web.blobs.add", add);
    registry.add_push("web.blobs.releaseDevice", release_device);
    registry.add_push("web.media.head", media_head);
    registry.add_push("web.media.chunk", media_chunk);
    registry.add_push("web.media.end", media_end);
    registry.add("web.blobs.release", |call| Box::pin(release(call)));
    registry.add("web.blobs.mediaUrl", |call| Box::pin(media_url(call)));
    registry.add("web.blobs.count", |call| Box::pin(count(call)));
    registry.add("web.blobs.serve", |call| Box::pin(serve(call)));
}

/// A token minted the way main does (24 random bytes, base64url).
#[cfg(test)]
fn mint() -> String {
    use base64::Engine as _;
    let mut bytes = [0; 24];
    crate::sys::random(&mut bytes).unwrap();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU64 as Counter;

    use hyper::server::conn::http1;
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::{TcpListener, TcpStream};

    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            static COUNT: Counter = Counter::new(0);
            let dir = std::env::temp_dir().join(format!(
                "ompdesk-core-blobs-{}-{}",
                std::process::id(),
                COUNT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const NOW: i64 = 1_000_000;
    const DIGITS: &[u8] = b"0123456789";

    fn store() -> BlobStore {
        BlobStore::new("test".to_owned(), IDLE_TTL_MS)
    }

    fn add_bytes(store: &BlobStore, device: &str, mime: &str, name: &str) -> String {
        let token = mint();
        store.add(
            NOW,
            &token,
            NewBlob {
                device,
                source: Source::Bytes(Bytes::from_static(DIGITS)),
                mime,
                name,
                download: false,
            },
        );
        format!("{URL_PREFIX}{token}")
    }

    fn add_file(store: &BlobStore, device: &str, abs: PathBuf, download: bool) -> String {
        let token = mint();
        store.add(
            NOW,
            &token,
            NewBlob {
                device,
                source: Source::File(abs),
                mime: "application/octet-stream",
                name: "clip.bin",
                download,
            },
        );
        format!("{URL_PREFIX}{token}")
    }

    async fn get(
        store: &BlobStore,
        device: &str,
        url: &str,
        range: Option<&str>,
    ) -> (u16, Headers, Vec<u8>) {
        store
            .answer(NOW, device, url, &Method::GET, range)
            .await
            .collect()
            .await
    }

    fn header<'a>(headers: &'a Headers, name: &str) -> Option<&'a str> {
        headers
            .iter()
            .find(|(have, _)| have == name)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn a_single_bytes_range_is_read() {
        let bytes = |start, end| Range::Bytes { start, end };
        assert_eq!(parse_range(None, 10), Range::Whole);
        assert_eq!(parse_range(Some(""), 10), Range::Whole);
        assert_eq!(parse_range(Some("bytes=0-3"), 10), bytes(0, 3));
        assert_eq!(parse_range(Some("bytes=4-"), 10), bytes(4, 9));
        assert_eq!(parse_range(Some("bytes=-3"), 10), bytes(7, 9));
        assert_eq!(parse_range(Some("bytes=5-500"), 10), bytes(5, 9));
        assert_eq!(parse_range(Some("bytes=-500"), 10), bytes(0, 9));
        assert_eq!(parse_range(Some("  bytes=2-3 "), 10), bytes(2, 3));
        assert_eq!(
            parse_range(Some("bytes=-5"), 0),
            bytes(0, -1),
            "a suffix of an empty body, as the TypeScript gave"
        );
    }

    #[test]
    fn a_range_that_cannot_be_met_is_invalid() {
        for bad in [
            "bytes=10-",
            "bytes=5-2",
            "bytes=-0",
            "bytes=-",
            "items=0-1",
            "bytes=0-1,3-4",
            "bytes=a-b",
            "bytes=0-1 x",
            "BYTES=0-1",
            "bytes=99999999999999999999999999-",
        ] {
            assert_eq!(parse_range(Some(bad), 10), Range::Invalid, "{bad}");
        }
        assert_eq!(parse_range(Some("bytes=0-"), 0), Range::Invalid);
    }

    #[test]
    fn the_content_disposition_is_ascii_with_the_name_percent_encoded() {
        assert_eq!(
            content_disposition("ü.png", true),
            "attachment; filename=\"_.png\"; filename*=UTF-8''%C3%BC.png"
        );
        assert_eq!(
            content_disposition("a \"b\"\\c😀.txt", false),
            "inline; filename=\"a _b__c__.txt\"; filename*=UTF-8''a%20%22b%22%5Cc%F0%9F%98%80.txt"
        );
        assert_eq!(
            content_disposition("it's (1)!.txt", false),
            "inline; filename=\"it's (1)!.txt\"; filename*=UTF-8''it's%20(1)!.txt"
        );
    }

    #[test]
    fn only_types_a_browser_would_run_are_active_content() {
        for active in [
            "text/html",
            "TEXT/HTML; charset=utf-8",
            "image/svg+xml",
            "application/xhtml+xml",
            "text/xml",
            "application/xml",
            "text/javascript",
            "application/x-javascript",
            "text/x-javascript;x=1",
        ] {
            assert!(is_active_content(active), "{active}");
        }
        for plain in [
            "text/plain",
            "image/png",
            "text/htmlx",
            "application/xmlish",
            "text/javascripts",
            " text/html",
            "video/webm",
        ] {
            assert!(!is_active_content(plain), "{plain}");
        }
    }

    #[test]
    fn a_token_is_read_from_a_blob_url() {
        assert_eq!(token_of("/blob/abc-DEF_9"), Some("abc-DEF_9"));
        assert_eq!(token_of("/blob/abc?dl=1"), Some("abc"));
        assert_eq!(token_of("/blob/abc#x"), Some("abc"));
        for bad in [
            "/blob/",
            "/blob/../etc",
            "/blob/a/b",
            "/other/abc",
            "blob/abc",
            "/blob/a b",
            "/blob/?x",
        ] {
            assert_eq!(token_of(bad), None, "{bad}");
        }
        assert!(wants_download("/blob/a?dl=1"));
        assert!(wants_download("/blob/a?x=2&dl=1#f"));
        assert!(!wants_download("/blob/a?dl=0"));
        assert!(!wants_download("/blob/a#?dl=1"));
        assert!(!wants_download("/blob/a?dl=1x"));
    }

    #[tokio::test]
    async fn bytes_are_served_whole_and_by_range_with_the_headers_in_order() {
        let store = store();
        let url = add_bytes(&store, "dev1", "image/png", "a.png");
        let (status, headers, body) = get(&store, "dev1", &url, None).await;
        assert_eq!((status, body.as_slice()), (200, DIGITS));
        assert_eq!(
            headers
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            [
                "content-type",
                "accept-ranges",
                "content-disposition",
                "x-content-type-options",
                "cache-control",
                "content-security-policy",
                "cross-origin-resource-policy",
                "content-length",
            ]
        );
        assert_eq!(header(&headers, "cache-control"), Some("private, no-store"));
        assert_eq!(
            header(&headers, "content-security-policy"),
            Some("sandbox; default-src 'none'")
        );
        assert!(
            header(&headers, "content-disposition")
                .unwrap()
                .starts_with("inline;")
        );
        let (status, headers, body) = get(&store, "dev1", &url, Some("bytes=1-2")).await;
        assert_eq!((status, body.as_slice()), (206, b"12".as_slice()));
        assert_eq!(header(&headers, "content-range"), Some("bytes 1-2/10"));
        assert_eq!(header(&headers, "content-length"), Some("2"));
        let (status, headers, body) = get(&store, "dev1", &url, Some("bytes=99-")).await;
        assert_eq!((status, body.len()), (416, 0));
        assert_eq!(header(&headers, "content-range"), Some("bytes */10"));
        assert_eq!(header(&headers, "content-length"), None);
        let (_, headers, body) = store
            .answer(NOW, "dev1", &url, &Method::HEAD, None)
            .await
            .collect()
            .await;
        assert_eq!(
            (body.len(), header(&headers, "content-length")),
            (0, Some("10"))
        );
    }

    #[tokio::test]
    async fn a_file_is_served_whole_by_range_and_by_suffix() {
        let scratch = Scratch::new();
        let file = scratch.0.join("clip.bin");
        fs::write(&file, DIGITS).unwrap();
        let store = store();
        let url = add_file(&store, "dev1", file, false);
        let (status, headers, body) = get(&store, "dev1", &url, None).await;
        assert_eq!((status, body.as_slice()), (200, DIGITS));
        assert_eq!(header(&headers, "accept-ranges"), Some("bytes"));
        assert_eq!(header(&headers, "x-content-type-options"), Some("nosniff"));
        let (status, headers, body) = get(&store, "dev1", &url, Some("bytes=2-5")).await;
        assert_eq!((status, body.as_slice()), (206, b"2345".as_slice()));
        assert_eq!(header(&headers, "content-range"), Some("bytes 2-5/10"));
        assert_eq!(get(&store, "dev1", &url, Some("bytes=-3")).await.2, b"789");
        let (status, headers, _) = get(&store, "dev1", &url, Some("bytes=99-")).await;
        assert_eq!(status, 416);
        assert_eq!(header(&headers, "content-range"), Some("bytes */10"));
    }

    #[tokio::test]
    async fn a_file_larger_than_a_chunk_arrives_whole_and_in_range() {
        let scratch = Scratch::new();
        let file = scratch.0.join("big.bin");
        let data: Vec<u8> = (0..300_000_u32).map(|index| (index % 251) as u8).collect();
        fs::write(&file, &data).unwrap();
        let store = store();
        let url = add_file(&store, "dev1", file, false);
        assert_eq!(get(&store, "dev1", &url, None).await.2, data);
        assert_eq!(
            get(&store, "dev1", &url, Some("bytes=70000-200000"))
                .await
                .2,
            data[70_000..=200_000]
        );
    }

    #[tokio::test]
    async fn a_missing_file_a_folder_and_an_empty_file_are_answered_as_before() {
        let scratch = Scratch::new();
        let store = store();
        let gone = add_file(&store, "dev1", scratch.0.join("none"), true);
        assert_eq!(get(&store, "dev1", &gone, None).await.0, 404);
        let folder = add_file(&store, "dev1", scratch.0.clone(), false);
        assert_eq!(get(&store, "dev1", &folder, None).await.0, 404);
        let empty = scratch.0.join("empty");
        fs::write(&empty, b"").unwrap();
        let url = add_file(&store, "dev1", empty, false);
        let (status, headers, body) = get(&store, "dev1", &url, None).await;
        assert_eq!(
            (status, body.len(), header(&headers, "content-length")),
            (200, 0, Some("0"))
        );
        assert_eq!(get(&store, "dev1", &url, Some("bytes=0-0")).await.0, 416);
        let missing = get(&store, "dev1", &gone, None).await;
        assert_eq!(header(&missing.1, "content-type"), Some("text/plain"));
        assert_eq!(header(&missing.1, "cache-control"), Some("no-store"));
    }

    #[tokio::test]
    async fn another_devices_token_an_unknown_one_and_a_released_one_are_404() {
        let store = store();
        let url = add_bytes(&store, "dev1", "text/plain", "a.txt");
        assert_eq!(get(&store, "dev2", &url, None).await.0, 404);
        assert_eq!(get(&store, "dev1", "/blob/nope", None).await.0, 404);
        assert_eq!(get(&store, "dev1", "/blob/../etc", None).await.0, 404);
        assert!(!store.release("dev2", &url));
        assert!(store.release("dev1", &url));
        assert!(!store.release("dev1", &url));
        assert_eq!(get(&store, "dev1", &url, None).await.0, 404);
    }

    #[tokio::test]
    async fn a_token_idle_for_30_minutes_expires_and_a_request_keeps_it_alive() {
        let store = store();
        let url = add_bytes(&store, "dev1", "text/plain", "a.txt");
        let at = |now| store.answer(now, "dev1", &url, &Method::GET, None);
        assert_eq!(at(NOW + IDLE_TTL_MS - 1_000).await.status, 200);
        assert_eq!(at(NOW + 2 * IDLE_TTL_MS - 2_000).await.status, 200);
        assert_eq!(at(NOW + 3 * IDLE_TTL_MS - 1_999).await.status, 404);
        assert_eq!(store.count(), 0, "an expired token is forgotten");
    }

    #[tokio::test]
    async fn active_content_is_only_a_download_and_a_download_on_request() {
        let store = store();
        for mime in [
            "text/html",
            "image/svg+xml",
            "application/xhtml+xml",
            "text/javascript",
        ] {
            let url = add_bytes(&store, "dev1", mime, "page.html");
            let (_, headers, _) = get(&store, "dev1", &url, None).await;
            assert!(
                header(&headers, "content-disposition")
                    .unwrap()
                    .starts_with("attachment;"),
                "{mime}"
            );
            assert!(
                header(&headers, "content-security-policy")
                    .unwrap()
                    .contains("sandbox")
            );
        }
        let image = add_bytes(&store, "dev1", "image/png", "ü.png");
        assert!(
            header(
                &get(&store, "dev1", &image, None).await.1,
                "content-disposition"
            )
            .unwrap()
            .starts_with("inline;")
        );
        let forced = get(&store, "dev1", &format!("{image}?dl=1"), None).await;
        assert_eq!(
            header(&forced.1, "content-disposition"),
            Some("attachment; filename=\"_.png\"; filename*=UTF-8''%C3%BC.png")
        );
    }

    #[test]
    fn a_device_keeps_64_blobs_and_loses_all_when_forgotten() {
        let store = store();
        for _ in 0..70 {
            add_bytes(&store, "dev1", "text/plain", "f");
        }
        assert_eq!(store.count(), 64);
        add_bytes(&store, "dev2", "text/plain", "f");
        store.release_device("dev1");
        assert_eq!(store.count(), 1);
    }

    #[test]
    fn the_oldest_blob_is_the_one_pushed_out_even_when_added_in_the_same_millisecond() {
        let store = store();
        let first = add_bytes(&store, "dev1", "text/plain", "first");
        for _ in 0..63 {
            add_bytes(&store, "dev1", "text/plain", "f");
        }
        add_bytes(&store, "dev1", "text/plain", "last");
        assert!(!store.release("dev1", &first), "the first one went");
    }

    /// A stand-in for main: answers with a fixed body, or the range's part.
    struct Fake {
        asked: Mutex<Vec<(String, Option<String>)>>,
        fail: bool,
    }

    impl MediaOpener for Fake {
        fn open<'a>(
            &'a self,
            token: &'a str,
            url: &'a str,
            range: Option<&'a str>,
        ) -> BoxFuture<'a, Option<MediaAnswer>> {
            Box::pin(async move {
                self.asked
                    .lock()
                    .unwrap()
                    .push((format!("{token}|{url}"), range.map(str::to_owned)));
                if self.fail {
                    return None;
                }
                let (sender, body) = mpsc::channel(4);
                let (status, data, mut headers) = match range {
                    Some(_) => (
                        206,
                        &b"234"[..],
                        vec![("content-range".to_owned(), "bytes 2-4/10".to_owned())],
                    ),
                    None => (200, &b"0123456789"[..], Vec::new()),
                };
                headers.push(("content-type".to_owned(), "video/webm".to_owned()));
                headers.push(("content-length".to_owned(), data.len().to_string()));
                headers.push(("x-secret".to_owned(), "dropped".to_owned()));
                headers.push(("accept-ranges".to_owned(), String::new()));
                let chunk = Bytes::copy_from_slice(data);
                tokio::spawn(async move {
                    let _ = sender.send(chunk).await;
                });
                Some(MediaAnswer {
                    status,
                    headers,
                    body,
                })
            })
        }
    }

    fn media(store: &BlobStore, fail: bool) -> (String, Arc<Fake>) {
        let fake = Arc::new(Fake {
            asked: Mutex::default(),
            fail,
        });
        store.set_media_opener(fake.clone());
        let token = mint();
        store.add(
            NOW,
            &token,
            NewBlob {
                device: "dev1",
                source: Source::Media("omp-media://stream/t".to_owned()),
                mime: "video/webm",
                name: "media",
                download: false,
            },
        );
        (format!("{URL_PREFIX}{token}"), fake)
    }

    #[tokio::test]
    async fn a_media_stream_passes_through_its_status_range_and_only_its_four_headers() {
        let store = store();
        let (url, fake) = media(&store, false);
        let (status, headers, body) = get(&store, "dev1", &url, Some("bytes=2-4")).await;
        assert_eq!((status, body.as_slice()), (206, b"234".as_slice()));
        assert_eq!(header(&headers, "content-range"), Some("bytes 2-4/10"));
        assert_eq!(header(&headers, "x-secret"), None);
        assert_eq!(
            header(&headers, "accept-ranges"),
            Some("bytes"),
            "an empty value is not copied"
        );
        // The answer's content-type takes the place of the blob's own, which was the first header.
        assert_eq!(
            headers[0],
            ("content-type".to_owned(), "video/webm".to_owned())
        );
        assert_eq!(get(&store, "dev1", &url, None).await.2, b"0123456789");
        assert_eq!(
            store.media_url(NOW, "dev1", &url).as_deref(),
            Some("omp-media://stream/t")
        );
        assert_eq!(store.media_url(NOW, "dev2", &url), None);
        let asked = fake.asked.lock().unwrap().clone();
        assert_eq!(asked[0].1.as_deref(), Some("bytes=2-4"));
        assert_eq!(asked[1].1, None);
        assert!(asked[0].0.ends_with("|omp-media://stream/t"));
    }

    #[tokio::test]
    async fn a_media_stream_main_cannot_open_is_404() {
        let store = store();
        let (url, _) = media(&store, true);
        assert_eq!(get(&store, "dev1", &url, None).await.0, 404);
        let lonely = BlobStore::new("no-main".to_owned(), IDLE_TTL_MS);
        let token = mint();
        lonely.add(
            NOW,
            &token,
            NewBlob {
                device: "d",
                source: Source::Media("omp-media://stream/x".to_owned()),
                mime: "video/webm",
                name: "media",
                download: false,
            },
        );
        assert_eq!(
            get(&lonely, "d", &format!("{URL_PREFIX}{token}"), None)
                .await
                .0,
            404
        );
    }

    #[tokio::test]
    async fn main_answers_a_media_ask_with_pushes_and_the_core_acks_and_cancels() {
        let (events, _keep, mut frames) = Events::capture();
        let store = BlobStore::new("m".to_owned(), IDLE_TTL_MS);
        store.attach_events(events.clone());
        let token = mint();
        store.add(
            NOW,
            &token,
            NewBlob {
                device: "dev1",
                source: Source::Media("omp-media://stream/s".to_owned()),
                mime: "video/webm",
                name: "media",
                download: false,
            },
        );
        let url = format!("{URL_PREFIX}{token}");
        let served = tokio::spawn({
            let store = Arc::new(store);
            let url = url.clone();
            async move {
                store
                    .answer(NOW, "dev1", &url, &Method::GET, Some("bytes=0-"))
                    .await
                    .collect()
                    .await
            }
        });
        let parts = |frame: &crate::wire::Frame| {
            let (head, bin) = frame.parts();
            (
                serde_json::from_slice::<Value>(head).unwrap(),
                bin.map(<[u8]>::to_vec),
            )
        };
        let (ask, _) = parts(&frames.recv().await.unwrap());
        assert_eq!(ask["event"], "web.media.open");
        assert_eq!(ask["data"]["userData"], "m");
        assert_eq!(ask["data"]["token"], token);
        assert_eq!(ask["data"]["url"], "omp-media://stream/s");
        assert_eq!(ask["data"]["range"], "bytes=0-");
        let stream = ask["data"]["stream"].as_u64().unwrap();
        let push = |params: Value, bin: Option<Vec<u8>>| PushCall {
            params: serde_json::value::to_raw_value(&params).unwrap(),
            bin,
            events: events.clone(),
        };
        media_head(push(
            json!({"stream": stream, "status": 206, "headers": {"content-type": "video/webm", "content-range": "bytes 0-5/6", "x": "y"}}),
            None,
        ));
        media_chunk(push(json!({"stream": stream}), Some(b"abc".to_vec())));
        media_chunk(push(json!({"stream": stream}), Some(b"def".to_vec())));
        media_end(push(json!({"stream": stream}), None));
        let (status, headers, body) = served.await.unwrap();
        assert_eq!((status, body.as_slice()), (206, b"abcdef".as_slice()));
        assert_eq!(header(&headers, "content-range"), Some("bytes 0-5/6"));
        assert_eq!(header(&headers, "x"), None);
        let mut acked = 0;
        while let Ok(frame) = frames.try_recv() {
            let (event, _) = parts(&frame);
            assert_ne!(
                event["event"], "web.media.cancel",
                "an ended stream is not cancelled"
            );
            if event["event"] == "web.media.ack" {
                acked += event["data"]["bytes"].as_u64().unwrap();
            }
        }
        assert_eq!(acked, 6);
        assert!(
            streams().get(&stream).is_none(),
            "the stream is forgotten once served"
        );
    }

    #[tokio::test]
    async fn a_client_that_goes_before_the_end_cancels_the_stream_and_main_is_told() {
        let (events, _keep, mut frames) = Events::capture();
        let store = Arc::new(BlobStore::new("c".to_owned(), IDLE_TTL_MS));
        store.attach_events(events.clone());
        let token = mint();
        store.add(
            NOW,
            &token,
            NewBlob {
                device: "dev1",
                source: Source::Media("omp-media://stream/s".to_owned()),
                mime: "video/webm",
                name: "media",
                download: false,
            },
        );
        let answer = tokio::spawn({
            let (store, url) = (Arc::clone(&store), format!("{URL_PREFIX}{token}"));
            async move { store.answer(NOW, "dev1", &url, &Method::GET, None).await }
        });
        let ask = event(&frames.recv().await.unwrap());
        let stream = ask["data"]["stream"].as_u64().unwrap();
        let push = |params: Value, bin: Option<Vec<u8>>| PushCall {
            params: serde_json::value::to_raw_value(&params).unwrap(),
            bin,
            events: events.clone(),
        };
        media_head(push(
            json!({"stream": stream, "status": 200, "headers": {"content-length": "100"}}),
            None,
        ));
        media_chunk(push(json!({"stream": stream}), Some(vec![1; 10])));
        let answer = answer.await.unwrap();
        assert_eq!(answer.status, 200);
        // The page's connection ends: the body is dropped with the answer.
        drop(answer);
        loop {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(5), frames.recv())
                .await
                .expect("main is told")
                .unwrap();
            let event = event(&frame);
            if event["event"] == "web.media.cancel" {
                assert_eq!(event["data"]["stream"], stream);
                break;
            }
        }
        assert!(streams().get(&stream).is_none());
    }

    #[tokio::test]
    async fn a_released_media_blob_tells_main_it_is_gone() {
        let (events, _keep, mut frames) = Events::capture();
        let store = BlobStore::new("d".to_owned(), IDLE_TTL_MS);
        store.attach_events(events);
        let token = mint();
        store.add(
            NOW,
            &token,
            NewBlob {
                device: "dev1",
                source: Source::Media("omp-media://stream/s".to_owned()),
                mime: "video/webm",
                name: "media",
                download: false,
            },
        );
        assert!(store.release("dev1", &format!("{URL_PREFIX}{token}")));
        let dropped = event(&frames.recv().await.unwrap());
        assert_eq!(dropped["event"], "web.media.drop");
        assert_eq!(dropped["data"], json!({"userData": "d", "token": token}));
    }

    fn event(frame: &crate::wire::Frame) -> Value {
        serde_json::from_slice(frame.parts().0).unwrap()
    }

    /// One request over a real connection to hyper, as the edge writes the answer: everything the server sent.
    async fn over_http(store: Arc<BlobStore>, request: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let service = service_fn(move |request: Request<Incoming>| {
                let store = Arc::clone(&store);
                async move {
                    let range = range_header(&request);
                    let answer = store
                        .answer(
                            NOW,
                            "dev1",
                            request.uri().path_and_query().unwrap().as_str(),
                            request.method(),
                            range.as_deref(),
                        )
                        .await;
                    Ok::<_, std::convert::Infallible>(answer.into_response())
                }
            });
            let _ = http1::Builder::new()
                .serve_connection(TokioIo::new(socket), service)
                .await;
        });
        let mut client = TcpStream::connect(address).await.unwrap();
        client.write_all(request.as_bytes()).await.unwrap();
        let mut sent = Vec::new();
        client.read_to_end(&mut sent).await.unwrap();
        String::from_utf8_lossy(&sent).into_owned()
    }

    #[tokio::test]
    async fn hyper_writes_a_range_a_head_and_a_streamed_file_as_node_did() {
        let scratch = Scratch::new();
        let file = scratch.0.join("clip.bin");
        fs::write(&file, DIGITS).unwrap();
        let store = Arc::new(store());
        let url = add_file(&store, "dev1", file, false);
        let get = |range: &str, method: &str| {
            format!("{method} {url} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n{range}\r\n")
        };
        let whole = over_http(Arc::clone(&store), &get("", "GET")).await;
        assert!(whole.starts_with("HTTP/1.1 200 OK\r\n"), "{whole}");
        assert!(whole.contains("content-length: 10\r\n"), "{whole}");
        assert!(whole.ends_with("\r\n\r\n0123456789"), "{whole}");
        let part = over_http(Arc::clone(&store), &get("Range: bytes=2-5\r\n", "GET")).await;
        assert!(
            part.starts_with("HTTP/1.1 206 Partial Content\r\n"),
            "{part}"
        );
        assert!(part.contains("content-range: bytes 2-5/10\r\n"), "{part}");
        assert!(part.ends_with("\r\n\r\n2345"), "{part}");
        let head = over_http(Arc::clone(&store), &get("", "HEAD")).await;
        assert!(head.starts_with("HTTP/1.1 200 OK\r\n"), "{head}");
        assert!(head.contains("content-length: 10\r\n"), "{head}");
        assert!(head.ends_with("\r\n\r\n"), "{head}");
        let bad = over_http(Arc::clone(&store), &get("Range: bytes=99-\r\n", "GET")).await;
        assert!(
            bad.starts_with("HTTP/1.1 416 Range Not Satisfiable\r\n"),
            "{bad}"
        );
        assert!(bad.contains("content-range: bytes */10\r\n"), "{bad}");
        let gone = over_http(store, &get("", "GET").replace("/blob/", "/blob/x")).await;
        assert!(gone.starts_with("HTTP/1.1 404 Not Found\r\n"), "{gone}");
    }
}
