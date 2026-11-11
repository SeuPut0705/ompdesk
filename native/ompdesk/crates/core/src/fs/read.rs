//! Reads: text with a byte cap, bytes for the viewer and a download in parts, a markdown image, the plan file, the
//! head of a media file, and a stat. Bytes travel as the reply's `bin` tail; main sniffs their type
//! (`sniffMime`, which its callers need synchronously).

use std::io::{Seek, SeekFrom};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::disk;
use super::error::Codes;
use crate::server::{Fault, Reply};

const READ_DEFAULT_MAX_BYTES: f64 = 200_000.0;
const READ_MAX_BYTES_CAP: f64 = 2_000_000.0;
/// Markdown images become data URLs in the renderer; bound the bytes.
const IMAGE_MAX_BYTES: u64 = 25_000_000;

fn not_a_file() -> Fault {
    Fault::new("not_a_file", "Not a file")
}

/// A file's first `len` bytes (fewer when it is shorter).
fn read_head(file: &mut std::fs::File, len: u64, codes: Codes) -> Result<Vec<u8>, Fault> {
    let mut bytes = vec![0; len as usize];
    let read = disk::read_into(file, &mut bytes).map_err(|error| error.fault(codes))?;
    bytes.truncate(read);
    Ok(bytes)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextParams {
    path: String,
    max_bytes: Option<Value>,
}

#[derive(Serialize)]
struct Text {
    content: String,
    truncated: bool,
    binary: bool,
    size: u64,
}

/// A text file up to `maxBytes`; a NUL in the read region means binary, and the content comes back empty. A
/// character the cap cuts decodes as U+FFFD, as node's `toString("utf8")` decodes it.
pub fn read_text(params: &TextParams) -> Result<Reply, Fault> {
    let max = super::clamp_int(
        params.max_bytes.as_ref(),
        1.0,
        READ_MAX_BYTES_CAP,
        READ_DEFAULT_MAX_BYTES,
    ) as u64;
    let fail = |error: super::error::NodeError| error.fault(Codes::None);
    let meta = disk::stat(&params.path).map_err(fail)?;
    if !meta.is_file() {
        return Err(not_a_file());
    }
    let mut file = disk::open(&params.path).map_err(fail)?;
    let bytes = read_head(&mut file, meta.len().min(max + 1), Codes::None)?;
    if bytes.contains(&0) {
        return Reply::json(&Text {
            content: String::new(),
            truncated: false,
            binary: true,
            size: meta.len(),
        });
    }
    let shown = &bytes[..bytes.len().min(max as usize)];
    Reply::json(&Text {
        content: String::from_utf8_lossy(shown).into_owned(),
        truncated: meta.len() > max,
        binary: false,
        size: meta.len(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryParams {
    path: String,
    max_bytes: Option<Value>,
    /// Whole files up to this many bytes (the local or the paired-host cap).
    cap: f64,
    /// The head an over-cap answer carries: what main sniffs a type from.
    head: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Binary {
    size: u64,
    truncated: bool,
    /// Over the cap: the tail holds only the head main sniffs a type from.
    too_large: bool,
}

/// The viewer's read: a whole file up to `cap`; over it, `tooLarge` with the head. A `maxBytes` below the cap asks
/// for a prefix instead (the hex view).
pub fn read_binary(params: &BinaryParams) -> Result<Reply, Fault> {
    let cap = params.cap;
    let prefix = match params.max_bytes.as_ref().and_then(Value::as_f64) {
        Some(max) if max < cap => Some(super::clamp_int(params.max_bytes.as_ref(), 1.0, cap, cap)),
        _ => None,
    };
    let fail = |error: super::error::NodeError| error.fault(Codes::Missing);
    let meta = disk::stat(&params.path).map_err(fail)?;
    if !meta.is_file() {
        return Err(not_a_file());
    }
    let size = meta.len();
    let mut file = disk::open(&params.path).map_err(fail)?;
    if prefix.is_none() && size as f64 > cap {
        let head = read_head(&mut file, size.min(params.head), Codes::Missing)?;
        return Ok(Reply::json(&Binary {
            size,
            truncated: false,
            too_large: true,
        })?
        .with_bin(head));
    }
    let length = match prefix {
        None => size,
        Some(prefix) => size.min(prefix as u64),
    };
    let data = read_head(&mut file, length, Codes::Missing)?;
    Ok(Reply::json(&Binary {
        size,
        truncated: size > length,
        too_large: false,
    })?
    .with_bin(data))
}

#[derive(Deserialize)]
pub struct RangeParams {
    path: String,
    /// A safe non-negative integer (main checked it).
    offset: u64,
    length: Option<Value>,
    /// The most one slice carries.
    cap: f64,
}

#[derive(Serialize)]
struct Range {
    size: u64,
    truncated: bool,
}

/// One slice of a file for a download in parts. An offset at or past the end answers no bytes with the file's size;
/// `truncated` says bytes remain past the slice.
pub fn read_range(params: &RangeParams) -> Result<Reply, Fault> {
    let length = super::clamp_int(params.length.as_ref(), 0.0, params.cap, 0.0) as u64;
    let fail = |error: super::error::NodeError| error.fault(Codes::Missing);
    let meta = disk::stat(&params.path).map_err(fail)?;
    if !meta.is_file() {
        return Err(not_a_file());
    }
    let size = meta.len();
    let want = length.min(size.saturating_sub(params.offset));
    let mut file = disk::open(&params.path).map_err(fail)?;
    let mut data = vec![0; want as usize];
    let mut read = 0;
    if want > 0 {
        file.seek(SeekFrom::Start(params.offset)).map_err(|error| {
            super::error::NodeError::new(&error, "read", None).fault(Codes::Missing)
        })?;
        read = disk::read_into(&mut file, &mut data).map_err(fail)?;
    }
    data.truncate(read);
    Ok(Reply::json(&Range {
        size,
        truncated: params.offset + (read as u64) < size,
    })?
    .with_bin(data))
}

#[derive(Deserialize)]
pub struct ImageParams {
    path: String,
    /// The caller's copy (`{ mtimeMs, size }`): while the file still has both, no bytes come.
    known: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Image {
    size: u64,
    mtime_ms: f64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    unchanged: bool,
}

/// A markdown image: a regular file under 25 MB, whole in the tail; main checks it sniffs as an image.
pub fn read_image(params: &ImageParams) -> Result<Reply, Fault> {
    let fail = |error: super::error::NodeError| error.fault(Codes::None);
    let meta = disk::stat(&params.path).map_err(fail)?;
    if !meta.is_file() {
        return Err(not_a_file());
    }
    let size = meta.len();
    if size > IMAGE_MAX_BYTES {
        return Err(Fault::new("image_too_large", "Image too large"));
    }
    let mtime_ms = disk::mtime_ms(&meta);
    let known = |key: &str| {
        params
            .known
            .as_ref()
            .and_then(|known| known.get(key)?.as_f64())
    };
    if known("mtimeMs") == Some(mtime_ms) && known("size") == Some(size as f64) {
        return Reply::json(&Image {
            size,
            mtime_ms,
            unchanged: true,
        });
    }
    let mut file = disk::open(&params.path).map_err(fail)?;
    // The size the stat gave: a file that shrank since reads as zeros past its end, as the TypeScript's buffer did.
    let mut body = vec![0; size as usize];
    disk::read_into(&mut file, &mut body).map_err(fail)?;
    Ok(Reply::json(&Image {
        size,
        mtime_ms,
        unchanged: false,
    })?
    .with_bin(body))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanParams {
    /// The configured plan file, confined by main.
    target: String,
    /// The session-local root for the newest-`*plan.md` fallback.
    local_root: Option<String>,
}

#[derive(Serialize)]
struct Plan {
    /// The plan's text; `null` when no plan file exists.
    content: Option<String>,
    /// The fallback's file name in `localRoot` when the plan came from there.
    fallback: Option<String>,
}

/// The configured plan file when it is a file, else the newest top-level `*plan.md` (any case) in `localRoot`.
pub fn read_plan(params: &PlanParams) -> Result<Reply, Fault> {
    let target_is_file = disk::stat(&params.target).is_ok_and(|meta| meta.is_file());
    let (path, fallback) = if target_is_file {
        (params.target.clone(), None)
    } else {
        match params.local_root.as_deref().and_then(newest_plan_file) {
            Some((path, name)) => (path, Some(name)),
            None => {
                return Reply::json(&Plan {
                    content: None,
                    fallback: None,
                });
            }
        }
    };
    let fail = |error: super::error::NodeError| error.fault(Codes::None);
    let mut file = disk::open(&path).map_err(fail)?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut file, &mut bytes)
        .map_err(|error| super::error::NodeError::new(&error, "read", None).fault(Codes::None))?;
    Reply::json(&Plan {
        content: Some(String::from_utf8_lossy(&bytes).into_owned()),
        fallback,
    })
}

/// The newest file whose name ends in `plan.md` (ASCII case-insensitive, as `/plan\.md$/i` matched), first wins a
/// tie; its path and name.
fn newest_plan_file(dir: &str) -> Option<(String, String)> {
    let entries = disk::read_dir(dir).ok()?;
    let mut best: Option<(String, String, f64)> = None;
    for entry in entries {
        let name = entry.name.as_bytes();
        let is_plan = name.len() >= 7 && name[name.len() - 7..].eq_ignore_ascii_case(b"plan.md");
        if entry.kind != disk::Kind::File || !is_plan {
            continue;
        }
        let path = std::path::Path::new(dir).join(&entry.raw);
        let Some(path) = path.to_str() else { continue };
        let Ok(meta) = disk::stat(path) else { continue };
        let mtime = disk::mtime_ms(&meta);
        if best.as_ref().is_none_or(|(_, _, newest)| mtime > *newest) {
            best = Some((path.to_owned(), entry.name, mtime));
        }
    }
    best.map(|(path, name, _)| (path, name))
}

#[derive(Deserialize)]
pub struct MediaParams {
    path: String,
    /// The head's length: what main sniffs a type from.
    head: u64,
}

#[derive(Serialize)]
struct Media {
    size: u64,
}

/// A stream's file: a regular file, its size and its head (main checks it sniffs as audio or video).
pub fn resolve_media(params: &MediaParams) -> Result<Reply, Fault> {
    let fail = |error: super::error::NodeError| error.fault(Codes::Missing);
    let meta = disk::stat(&params.path).map_err(fail)?;
    if !meta.is_file() {
        return Err(not_a_file());
    }
    let mut file = disk::open(&params.path).map_err(fail)?;
    let head = read_head(&mut file, meta.len().min(params.head), Codes::Missing)?;
    Ok(Reply::json(&Media { size: meta.len() })?.with_bin(head))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stat {
    file: bool,
    directory: bool,
    size: u64,
    mtime_ms: f64,
}

#[derive(Deserialize)]
pub struct PathParams {
    path: String,
}

/// The path's kind, size and mtime (node's double), following links.
pub fn stat(params: &PathParams) -> Result<Reply, Fault> {
    let meta = disk::stat(&params.path).map_err(|error| error.fault(Codes::Fs))?;
    Reply::json(&Stat {
        file: meta.is_file(),
        directory: meta.is_dir(),
        size: meta.len(),
        mtime_ms: disk::mtime_ms(&meta),
    })
}

#[cfg(test)]
mod tests {
    /// Byte strings and what node's `Buffer.toString("utf8")` made of them (code points), captured from node 24.
    const NODE_DECODED: &[(&[u8], &[u32])] = &[
        (&[0x68, 0x69], &[0x68, 0x69]),
        (&[0xe2, 0x9c], &[0xfffd]),
        (&[0xe2, 0x9c, 0x93], &[0x2713]),
        (&[0xf0, 0x9f, 0x98], &[0xfffd]),
        (&[0xf0, 0x9f, 0x98, 0x80], &[0x1f600]),
        (&[0xc3], &[0xfffd]),
        (&[0x80], &[0xfffd]),
        (&[0xff, 0xfe], &[0xfffd, 0xfffd]),
        (&[0xed, 0xa0, 0x80], &[0xfffd, 0xfffd, 0xfffd]),
        (&[0xf4, 0x90, 0x80, 0x80], &[0xfffd, 0xfffd, 0xfffd, 0xfffd]),
        (&[0xe0, 0x80, 0x80], &[0xfffd, 0xfffd, 0xfffd]),
        (&[0xc0, 0xaf], &[0xfffd, 0xfffd]),
        (&[0xef, 0xbb, 0xbf, 0x61], &[0xfeff, 0x61]),
        (&[0x61, 0xf0, 0x9f, 0x61], &[0x61, 0xfffd, 0x61]),
        (&[0xf0, 0x80, 0x80], &[0xfffd, 0xfffd, 0xfffd]),
        (&[0xe1, 0x80, 0x41], &[0xfffd, 0x41]),
    ];

    #[test]
    fn decodes_a_cut_or_broken_text_as_node_does() {
        for (bytes, expected) in NODE_DECODED {
            let decoded: Vec<u32> = String::from_utf8_lossy(bytes)
                .chars()
                .map(u32::from)
                .collect();
            assert_eq!(&decoded, expected, "{bytes:x?}");
        }
    }
}
