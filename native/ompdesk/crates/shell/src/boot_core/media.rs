//! `omp-media://`: audio and video for the page's players, streamed from disk with range requests so a long recording
//! seeks and plays without a Node process. A URL is a capability, never a path: the authenticated caller's file
//! handler resolves a workspace file before registering it. Owner ids come from the native caller registry, never
//! from page arguments. Tokens and open bodies are revoked when that owner closes or navigates. Was
//! `src/main/media-stream.ts`; its range rule is kept as it was, which is stricter than `range.rs`'s for `app://`
//! (a list of ranges or another unit is 416 here).

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use super::js_space;

pub const SCHEME: &str = "omp-media";
pub const URL_PREFIX: &str = "omp-media://stream/";

#[derive(Debug, Clone, PartialEq)]
pub enum Range {
    /// No header: the whole body, 200.
    None,
    /// 416.
    Invalid,
    /// First and last byte, inclusive.
    Bytes(u64, u64),
}

/// `bytes=a-b`, `bytes=a-`, `bytes=-n` against `size` (`parseRange`): anything else is unsatisfiable.
pub fn parse_range(header: Option<&str>, size: u64) -> Range {
    let Some(header) = header.filter(|h| !h.is_empty()) else {
        return Range::None;
    };
    let Some(spec) = header.trim_matches(js_space).strip_prefix("bytes=") else {
        return Range::Invalid;
    };
    let Some((a, b)) = spec.split_once('-') else {
        return Range::Invalid;
    };
    let digits = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
    if !digits(a) || !digits(b) || (a.is_empty() && b.is_empty()) {
        return Range::Invalid;
    }
    // JavaScript's `Number(digits)`: a double, as the TypeScript compared.
    let number = |s: &str| s.parse::<f64>().unwrap_or(0.0);
    let size_f = size as f64;
    let (start, end) = if a.is_empty() {
        let suffix = number(b);
        if suffix == 0.0 {
            return Range::Invalid;
        }
        ((size_f - suffix).max(0.0), size_f - 1.0)
    } else {
        let start = number(a);
        let end = if b.is_empty() {
            size_f - 1.0
        } else {
            number(b).min(size_f - 1.0)
        };
        (start, end)
    };
    if start >= size_f || end < start {
        return Range::Invalid;
    }
    Range::Bytes(start as u64, end as u64)
}

/// Constructed by the native caller boundary, never deserialized from a page request.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Owner {
    Desktop {
        win_id: u64,
        wc_id: u64,
    },
    Web {
        device_id: String,
        conn_id: String,
        window_id: i64,
    },
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub path: PathBuf,
    pub mime: String,
    /// The page (`wcId`, or a paired device's page id) that may release it.
    pub owner: Owner,
    lease: Arc<Lease>,
}

type BodySlot = Mutex<Option<Body>>;
type BodyHandle = Arc<BodySlot>;

#[derive(Debug)]
struct Lease {
    live: AtomicBool,
    bodies: Mutex<Vec<Weak<BodySlot>>>,
}

impl Entry {
    fn revoke(&self) {
        self.lease.live.store(false, Ordering::Release);
        for body in self
            .lease
            .bodies
            .lock()
            .unwrap()
            .drain(..)
            .filter_map(|body| body.upgrade())
        {
            body.lock().unwrap().take();
        }
    }
}

/// The registered tokens.
#[derive(Debug, Default)]
pub struct Streams {
    entries: HashMap<String, Entry>,
}

/// The token of `url`, query and fragment dropped; empty for a URL of another shape.
fn token_of(url: &str) -> &str {
    url.strip_prefix(URL_PREFIX)
        .map(|rest| rest.split(['?', '#']).next().unwrap_or(""))
        .unwrap_or("")
}

impl Streams {
    /// Registers `path` for `owner` under `token` (24 random bytes, base64url); returns its URL.
    pub fn open(&mut self, path: PathBuf, mime: String, owner: Owner, token: String) -> String {
        let url = format!("{URL_PREFIX}{token}");
        self.entries.insert(
            token,
            Entry {
                path,
                mime,
                owner,
                lease: Arc::new(Lease {
                    live: AtomicBool::new(true),
                    bodies: Mutex::new(Vec::new()),
                }),
            },
        );
        url
    }

    /// Forgets one URL; only its owner may.
    pub fn release(&mut self, url: &str, owner: &Owner) {
        let token = token_of(url);
        if self.entries.get(token).is_some_and(|e| &e.owner == owner)
            && let Some(entry) = self.entries.remove(token)
        {
            entry.revoke();
        }
    }

    /// Forgets every URL a page held (it closed or reloaded).
    pub fn release_owner(&mut self, owner: &Owner) {
        self.entries.retain(|_, entry| {
            if &entry.owner == owner {
                entry.revoke();
                false
            } else {
                true
            }
        });
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entry(&self, url: &str) -> Option<&Entry> {
        self.entries.get(token_of(url))
    }
    fn clear(&mut self) {
        for entry in self.entries.values() {
            entry.revoke();
        }
        self.entries.clear();
    }
}

/// Shared by native file handlers, the app scheme and paired-page streams. Stopping is terminal: no capability
/// may be created after the app started draining its callers.
pub struct Service {
    streams: Mutex<Option<Streams>>,
}

impl Default for Service {
    fn default() -> Self {
        Self {
            streams: Mutex::new(Some(Streams::default())),
        }
    }
}

impl Service {
    /// `path` has already passed the authenticated caller's workspace checks.
    pub fn open(&self, path: PathBuf, mime: String, owner: Owner) -> io::Result<String> {
        let mut bytes = [0u8; 24];
        getrandom::fill(&mut bytes)
            .map_err(|error| io::Error::other(format!("no random token: {error}")))?;
        let mut streams = self.streams.lock().unwrap();
        let streams = streams.as_mut().ok_or_else(stopped)?;
        Ok(streams.open(path, mime, owner, URL_SAFE_NO_PAD.encode(bytes)))
    }

    pub fn release(&self, url: &str, owner: &Owner) {
        if let Some(streams) = self.streams.lock().unwrap().as_mut() {
            streams.release(url, owner);
        }
    }

    pub fn release_owner(&self, owner: &Owner) {
        if let Some(streams) = self.streams.lock().unwrap().as_mut() {
            streams.release_owner(owner);
        }
    }

    pub fn stop(&self) {
        if let Some(mut streams) = self.streams.lock().unwrap().take() {
            streams.clear();
        }
    }

    fn entry(&self, url: &str) -> Option<Entry> {
        self.streams.lock().unwrap().as_ref()?.entry(url).cloned()
    }

    /// The header and file are taken from the same open handle. Replacement or removal of a path cannot produce
    /// an advertised success with a missing body, and revocation prevents subsequent reads from an open handle.
    pub fn prepare(&self, url: &str, method: &str, range: Option<&str>) -> Prepared {
        let missing = || Prepared {
            head: Head::bare(404),
            body: None,
        };
        let Some(entry) = self.entry(url) else {
            return missing();
        };
        if method != "GET" && method != "HEAD" {
            return missing();
        }
        let Ok(mut file) = File::open(&entry.path) else {
            return missing();
        };
        let Ok(meta) = file.metadata() else {
            return missing();
        };
        if !meta.is_file() || !entry.lease.live.load(Ordering::Acquire) {
            return missing();
        }
        let head = answer_size(&entry, method, range, meta.len());
        let body = if head.length > 0 {
            if file.seek(SeekFrom::Start(head.start)).is_err() {
                return missing();
            }
            let body = Arc::new(Mutex::new(Some(Body {
                file,
                left: head.length,
            })));
            let mut bodies = entry.lease.bodies.lock().unwrap();
            if !entry.lease.live.load(Ordering::Acquire) {
                return missing();
            }
            bodies.retain(|body| body.strong_count() > 0);
            bodies.push(Arc::downgrade(&body));
            Some(body)
        } else {
            None
        };
        Prepared { head, body }
    }

    /// A bounded chunk for a paired-page stream. The caller never chooses an arbitrary path.
    pub fn read(&self, url: &str, offset: u64, length: u64) -> io::Result<Vec<u8>> {
        let entry = self.entry(url).ok_or_else(released)?;
        let mut file = File::open(&entry.path)?;
        file.seek(SeekFrom::Start(offset))?;
        let want = length.min(1 << 20);
        let mut bytes = Vec::new();
        file.take(want).read_to_end(&mut bytes)?;
        if !entry.lease.live.load(Ordering::Acquire) {
            return Err(released());
        }
        Ok(bytes)
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.stop();
    }
}

fn stopped() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "the media service is stopped")
}

fn released() -> io::Error {
    io::Error::new(io::ErrorKind::NotFound, "the media stream was released")
}

pub struct Prepared {
    pub head: Head,
    body: Option<BodyHandle>,
}

#[derive(Debug)]
struct Body {
    file: File,
    left: u64,
}

impl Read for Prepared {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        let Some(body) = self.body.as_ref() else {
            return Ok(0);
        };
        let mut slot = body.lock().unwrap();
        let Some(body) = slot.as_mut() else {
            return Ok(0);
        };
        let want = (out.len() as u64).min(body.left) as usize;
        let read = body.file.read(&mut out[..want])?;
        body.left -= read as u64;
        if read == 0 || body.left == 0 {
            slot.take();
        }
        Ok(read)
    }
}

/// A response's head and which bytes of the file its body is.
#[derive(Debug, Clone, PartialEq)]
pub struct Head {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub start: u64,
    /// Body bytes from `start`; 0 for no body (404, 416, HEAD, an empty file).
    pub length: u64,
}

impl Head {
    fn bare(status: u16) -> Head {
        Head {
            status,
            headers: Vec::new(),
            start: 0,
            length: 0,
        }
    }
}

pub fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        206 => "Partial Content",
        416 => "Range Not Satisfiable",
        _ => "Not Found",
    }
}

fn answer_size(entry: &Entry, method: &str, range: Option<&str>, size: u64) -> Head {
    let mut headers = vec![
        ("Accept-Ranges", "bytes".to_string()),
        ("Content-Type", entry.mime.clone()),
        ("Cache-Control", "no-store".to_string()),
    ];
    let (start, end, partial) = match parse_range(range, size) {
        Range::Invalid => {
            headers.push(("Content-Range", format!("bytes */{size}")));
            return Head {
                status: 416,
                headers,
                start: 0,
                length: 0,
            };
        }
        Range::None => (0i128, size as i128 - 1, false),
        Range::Bytes(a, b) => (a as i128, b as i128, true),
    };
    let length = (end - start + 1).max(0) as u64;
    headers.push(("Content-Length", length.to_string()));
    if partial {
        headers.push(("Content-Range", format!("bytes {start}-{end}/{size}")));
    }
    let body = method != "HEAD" && size > 0;
    Head {
        status: if partial { 206 } else { 200 },
        headers,
        start: start as u64,
        length: if body { length } else { 0 },
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn replays_the_media_answers_as_captured() {
        let captured: Value = serde_json::from_str(include_str!("captured.json")).unwrap();
        let size = captured["mediaSize"].as_u64().unwrap();
        let bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        let clip = Clip::new(&bytes);
        let empty = Clip::new(b"");
        let streams = Service::default();
        let clip_url = streams
            .open(clip.path.clone(), "video/webm".into(), owner(1))
            .unwrap();
        let empty_url = streams
            .open(empty.path.clone(), "audio/ogg".into(), owner(1))
            .unwrap();
        let cases = captured["media"].as_array().unwrap();
        assert_eq!(cases.len(), 99);
        for case in cases {
            let (url, range) = match case["file"].as_str().unwrap() {
                "clip" => (clip_url.clone(), case["range"].as_str()),
                "empty" => (empty_url.clone(), case["range"].as_str()),
                // A URL the capture asked for: its own clip token with a query or a fragment, or a guess.
                _ => {
                    let asked = case["range"].as_str().unwrap();
                    let suffix = asked.find(['?', '#']).map_or("", |at| &asked[at..]);
                    let url = if asked.ends_with("guess") {
                        asked.to_string()
                    } else {
                        format!("{clip_url}{suffix}")
                    };
                    (url, None)
                }
            };
            let mut response = streams.prepare(&url, case["method"].as_str().unwrap(), range);
            let mut body = Vec::new();
            response.read_to_end(&mut body).unwrap();
            let head = response.head;
            let mut headers: Vec<(String, String)> = head
                .headers
                .iter()
                .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
                .collect();
            headers.sort();
            let has_body = !body.is_empty();
            let got = json!({
                "status": head.status,
                "headers": headers.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
                "bodyLength": if has_body { json!(body.len()) } else { Value::Null },
                "bodyFirst": if has_body { json!(body[0]) } else { Value::Null },
            });
            let expected = json!({
                "status": case["status"], "headers": case["headers"],
                "bodyLength": case["bodyLength"], "bodyFirst": case["bodyFirst"],
            });
            if case["file"] == "url" {
                assert_eq!(got["status"], expected["status"], "{case}");
            } else {
                assert_eq!(got, expected, "{case}");
            }
        }
    }

    #[test]
    fn serves_registered_tokens_only_until_their_owner_releases_them() {
        let mut streams = Streams::default();
        let url = streams.open("/x".into(), "video/webm".into(), owner(1), "a".into());
        let other = streams.open("/x".into(), "video/webm".into(), owner(2), "b".into());
        assert!(streams.entry("omp-media://stream/guess").is_none());
        streams.release(&url, &owner(2));
        assert!(streams.entry(&url).is_some());
        streams.release(&url, &owner(1));
        assert!(streams.entry(&url).is_none());
        streams.release_owner(&owner(2));
        assert!(streams.entry(&other).is_none());
        assert!(streams.is_empty());
    }

    fn owner(wc_id: u64) -> Owner {
        Owner::Desktop { win_id: 1, wc_id }
    }

    struct Clip {
        dir: PathBuf,
        path: PathBuf,
    }

    impl Clip {
        fn new(bytes: &[u8]) -> Self {
            let mut token = [0u8; 12];
            getrandom::fill(&mut token).unwrap();
            let dir =
                std::env::temp_dir().join(format!("boot-media-{}", URL_SAFE_NO_PAD.encode(token)));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("clip.webm");
            std::fs::write(&path, bytes).unwrap();
            Self { dir, path }
        }
    }

    impl Drop for Clip {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.dir).unwrap();
        }
    }

    #[test]
    fn native_media_serves_the_advertised_range_with_backpressure() {
        let clip = Clip::new(b"0123456789");
        let media = Service::default();
        let url = media
            .open(clip.path.clone(), "video/webm".into(), owner(7))
            .unwrap();
        let mut body = media.prepare(&url, "GET", Some("bytes=3-6"));
        assert_eq!(body.head.status, 206);
        assert_eq!(body.head.length, 4);
        assert!(
            body.head
                .headers
                .contains(&("Content-Range", "bytes 3-6/10".into()))
        );
        let mut first = [0u8; 2];
        assert_eq!(body.read(&mut first).unwrap(), 2);
        assert_eq!(&first, b"34");
        let mut rest = Vec::new();
        body.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, b"56");
        assert_eq!(
            media.prepare(&url, "HEAD", None).read(&mut first).unwrap(),
            0
        );
        let mut invalid = media.prepare(&url, "GET", Some("bytes=30-40"));
        assert_eq!(invalid.head.status, 416);
        assert_eq!(invalid.read(&mut first).unwrap(), 0);
    }

    #[test]
    fn owner_revocation_stops_open_bodies_and_new_paired_reads() {
        let clip = Clip::new(b"0123456789");
        let media = Service::default();
        let url = media
            .open(clip.path.clone(), "video/webm".into(), owner(7))
            .unwrap();
        let mut body = media.prepare(&url, "GET", None);
        media.release(&url, &owner(8));
        let mut bytes = [0u8; 2];
        assert_eq!(body.read(&mut bytes).unwrap(), 2);
        assert_eq!(&bytes, b"01");
        media.release(&format!("{url}?player=1"), &owner(7));
        assert_eq!(body.read(&mut bytes).unwrap(), 0);
        assert_eq!(media.prepare(&url, "GET", None).head.status, 404);
        assert_eq!(
            media.read(&url, 0, 1).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
    }

    #[test]
    fn shutdown_revokes_all_owners_and_never_creates_a_new_lease() {
        let clip = Clip::new(b"abcdef");
        let media = Service::default();
        let a = media
            .open(clip.path.clone(), "audio/ogg".into(), owner(7))
            .unwrap();
        let b = media
            .open(clip.path.clone(), "audio/ogg".into(), owner(8))
            .unwrap();
        let mut a_body = media.prepare(&a, "GET", None);
        let mut b_body = media.prepare(&b, "GET", None);
        media.release_owner(&owner(7));
        let mut bytes = [0u8; 2];
        assert_eq!(a_body.read(&mut bytes).unwrap(), 0);
        assert_eq!(b_body.read(&mut bytes).unwrap(), 2);
        media.stop();
        media.stop();
        assert_eq!(b_body.read(&mut bytes).unwrap(), 0);
        assert_eq!(media.prepare(&b, "GET", None).head.status, 404);
        assert_eq!(
            media
                .open(clip.path.clone(), "audio/ogg".into(), owner(7))
                .unwrap_err()
                .kind(),
            io::ErrorKind::BrokenPipe
        );
    }

    #[test]
    fn paired_reads_are_bounded_and_unknown_tokens_never_open_paths() {
        let clip = Clip::new(&vec![42u8; (1 << 20) + 100]);
        let media = Service::default();
        let url = media
            .open(clip.path.clone(), "video/webm".into(), owner(7))
            .unwrap();
        assert_eq!(
            media.read(&url, 100, u64::MAX).unwrap(),
            vec![42u8; 1 << 20]
        );
        assert!(media.read(&url, (1 << 20) + 100, 9).unwrap().is_empty());
        assert_eq!(
            media
                .prepare(&clip.path.to_string_lossy(), "GET", None)
                .head
                .status,
            404
        );
        assert_eq!(
            media
                .prepare("omp-media://stream/guess", "GET", None)
                .head
                .status,
            404
        );
    }

    #[test]
    fn a_web_connection_can_release_only_its_own_media_leases() {
        let clip = Clip::new(b"abcdef");
        let media = Service::default();
        let owner = Owner::Web {
            device_id: "test-device".into(),
            conn_id: "current".into(),
            window_id: -7,
        };
        let stale = Owner::Web {
            device_id: "test-device".into(),
            conn_id: "former".into(),
            window_id: -7,
        };
        let url = media
            .open(clip.path.clone(), "audio/ogg".into(), owner.clone())
            .unwrap();
        media.release_owner(&stale);
        assert_eq!(media.read(&url, 0, 6).unwrap(), b"abcdef");
        media.release_owner(&owner);
        assert_eq!(media.prepare(&url, "GET", None).head.status, 404);
    }
}
