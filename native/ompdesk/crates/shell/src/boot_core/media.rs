//! `omp-media://`: audio and video for the page's players, streamed from disk with range requests so a long recording
//! seeks and plays without its bytes crossing the host socket. A URL is a capability, never a path: Node resolves a
//! file the page asked for (`resolveWorkspaceMedia`) and registers it (`boot.mediaOpen`); the scheme serves registered
//! tokens only, so model text can never name a file here. Tokens die when their page releases them or goes away. Was
//! `src/main/media-stream.ts`; its range rule is kept as it was, which is stricter than `range.rs`'s for `app://`
//! (a list of ranges or another unit is 416 here).

use std::collections::HashMap;
use std::path::PathBuf;

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

#[derive(Debug, Clone)]
pub struct Entry {
    pub path: PathBuf,
    pub mime: String,
    /// The page (`wcId`, or a paired device's page id) that may release it.
    pub owner: u64,
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
    pub fn open(&mut self, path: PathBuf, mime: String, owner: u64, token: String) -> String {
        let url = format!("{URL_PREFIX}{token}");
        self.entries.insert(token, Entry { path, mime, owner });
        url
    }

    /// Forgets one URL; only its owner may.
    pub fn release(&mut self, url: &str, owner: u64) {
        let Some(token) = url.strip_prefix(URL_PREFIX) else {
            return;
        };
        if self.entries.get(token).is_some_and(|e| e.owner == owner) {
            self.entries.remove(token);
        }
    }

    /// Forgets every URL a page held (it closed or reloaded).
    pub fn release_owner(&mut self, owner: u64) {
        self.entries.retain(|_, e| e.owner != owner);
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

/// `MediaStreams.handle`'s answer for a registered `entry` (or none), stating the file now.
pub fn answer(entry: Option<&Entry>, method: &str, range: Option<&str>) -> Head {
    let Some(entry) = entry else {
        return Head::bare(404);
    };
    if method != "GET" && method != "HEAD" {
        return Head::bare(404);
    }
    let size = match std::fs::metadata(&entry.path) {
        Ok(meta) if meta.is_file() => meta.len(),
        _ => return Head::bare(404),
    };
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
        let dir = std::env::temp_dir().join(format!("boot-media-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip = dir.join("clip.webm");
        let bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        std::fs::write(&clip, &bytes).unwrap();
        let empty = dir.join("empty.webm");
        std::fs::write(&empty, b"").unwrap();
        let mut streams = Streams::default();
        let clip_url = streams.open(clip, "video/webm".into(), 1, "c".repeat(32));
        let empty_url = streams.open(empty, "audio/ogg".into(), 1, "e".repeat(32));
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
            let head = answer(streams.entry(&url), case["method"].as_str().unwrap(), range);
            let mut headers: Vec<(String, String)> = head
                .headers
                .iter()
                .map(|(k, v)| (k.to_ascii_lowercase(), v.clone()))
                .collect();
            headers.sort();
            let has_body = head.length > 0;
            let got = json!({
                "status": head.status,
                "headers": headers.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
                "bodyLength": if has_body { json!(head.length) } else { Value::Null },
                "bodyFirst": if has_body { json!(bytes[head.start as usize]) } else { Value::Null },
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn serves_registered_tokens_only_until_their_owner_releases_them() {
        let mut streams = Streams::default();
        let url = streams.open("/x".into(), "video/webm".into(), 1, "a".into());
        let other = streams.open("/x".into(), "video/webm".into(), 2, "b".into());
        assert!(streams.entry("omp-media://stream/guess").is_none());
        streams.release(&url, 2);
        assert!(streams.entry(&url).is_some());
        streams.release(&url, 1);
        assert!(streams.entry(&url).is_none());
        streams.release_owner(2);
        assert!(streams.entry(&other).is_none());
        assert!(streams.is_empty());
    }
}
