//! What `ompdesk_session_send`, `ompdesk_report` and `ompdesk_session_answer` carry besides text (the owner's call,
//! 13 Nov 2026: a screenshot a person pasted into one session reached another only as a retyped description). An
//! attachment is `{path}` (a file on the computer the CALLER's omp runs on) or `{image: n}` (the n-th newest picture of
//! the caller's own conversation); the caller's omp reads it (`agent_control_attachment`).
//!
//! A picture of a type models read goes inline (stock `prompt.images`, an image block of a report's custom message);
//! any other file lands on the RECEIVER's computer and the text names its path there. At most
//! `INLINE_IMAGE_BUDGET_BYTES` of pictures go inline per message, the rest land as files.
//!
//! The outboxes re-deliver a message after a relaunch, so what it carried is kept by content address
//! (`AttachmentStore`, `<userData>/agent-attachments/<sha256>`, 0600) and the entries keep only references. The store
//! is swept of what no entry names. A record of attachments that cannot be read is `Attached::Corrupt`, never "none":
//! the message would go without what it carries.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::{Clock, js_number, object, string, system_clock};

/// The most one attachment may weigh (its base64 is one frame inside the link's 16 MiB).
pub const ATTACHMENT_MAX_BYTES: usize = 10 * 1024 * 1024;
/// Pictures past this many bytes (all of one message) land as files instead of going inline.
pub const INLINE_IMAGE_BUDGET_BYTES: usize = 8 * 1024 * 1024;
/// A stored attachment no outbox entry names is kept this long (an entry being made is not in any outbox yet).
pub const ATTACHMENT_SWEEP_GRACE_MS: f64 = 60.0 * 60_000.0;
/// An upload folder file is deleted after 24 hours (`UPLOAD_TTL_MS`).
pub const UPLOAD_TTL_MS: f64 = 24.0 * 60.0 * 60_000.0;
/// A path an upload is reused for this long: shorter than the store's lifetime, so the file is still there.
pub const LANDED_FRESH_MS: f64 = UPLOAD_TTL_MS - 60.0 * 60_000.0;

const IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/// The pictures a model reads inline.
pub fn is_image_type(mime: &str) -> bool {
    IMAGE_TYPES.contains(&mime)
}

#[derive(Debug, Clone, PartialEq)]
pub struct AttachmentRef {
    pub sha256: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
}

/// A file landed on the receiver's computer: its path there, and when (an upload is deleted after 24 hours).
#[derive(Debug, Clone, PartialEq)]
pub struct LandedFile {
    pub file: AttachmentRef,
    pub path: String,
    pub landed_at: f64,
}

/// What a stored message carries: the pictures by reference, and the files as landed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AttachedSet {
    pub images: Vec<AttachmentRef>,
    pub files: Vec<LandedFile>,
}

/// An outbox entry's `attachments` as read from its file.
#[derive(Debug, Clone, PartialEq)]
pub enum Attached {
    None,
    Set(AttachedSet),
    /// A record is there and cannot be read.
    Corrupt,
}

impl AttachedSet {
    pub fn count(&self) -> usize {
        self.images.len() + self.files.len()
    }

    pub fn shas(&self) -> impl Iterator<Item = &str> {
        self.images
            .iter()
            .map(|image| image.sha256.as_str())
            .chain(self.files.iter().map(|file| file.file.sha256.as_str()))
    }

    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert(
            "images".into(),
            Value::Array(self.images.iter().map(AttachmentRef::to_json).collect()),
        );
        map.insert(
            "files".into(),
            Value::Array(self.files.iter().map(LandedFile::to_json).collect()),
        );
        Value::Object(map)
    }

    /// The lines of a text that name the files landed for its receiver.
    pub fn attached_lines(&self) -> Vec<String> {
        self.files
            .iter()
            .map(|file| format!("Attached: {}", file.path))
            .collect()
    }

    /// What the sender is told was attached: `attached: 2 (1 image inline, 1 file at /path)`.
    pub fn summary(&self) -> String {
        let count = self.count();
        if count == 0 {
            return String::new();
        }
        let mut parts = Vec::new();
        if !self.images.is_empty() {
            let n = self.images.len();
            parts.push(format!("{n} image{} inline", if n == 1 { "" } else { "s" }));
        }
        if !self.files.is_empty() {
            let n = self.files.len();
            let paths: Vec<&str> = self.files.iter().map(|file| file.path.as_str()).collect();
            parts.push(format!(
                "{n} file{} at {}",
                if n == 1 { "" } else { "s" },
                paths.join(", ")
            ));
        }
        format!("attached: {count} ({})", parts.join(", "))
    }
}

/// `text` followed by one `Attached:` line per landed file.
pub fn with_attached(text: &str, files: &[LandedFile]) -> String {
    if files.is_empty() {
        return text.to_owned();
    }
    let lines: Vec<String> = files
        .iter()
        .map(|file| format!("Attached: {}", file.path))
        .collect();
    format!("{text}\n\n{}", lines.join("\n"))
}

/// What identifies a set of attachments: their SHA-256s, sorted and unique.
pub fn shas_sig<'a>(shas: impl IntoIterator<Item = &'a str>) -> String {
    let mut all: Vec<&str> = shas.into_iter().collect();
    all.sort_unstable();
    all.dedup();
    all.join(",")
}

pub fn attached_sig(set: Option<&AttachedSet>) -> String {
    shas_sig(set.into_iter().flat_map(AttachedSet::shas))
}

impl AttachmentRef {
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("sha256".into(), self.sha256.clone().into());
        map.insert("name".into(), self.name.clone().into());
        map.insert("mimeType".into(), self.mime_type.clone().into());
        map.insert("size".into(), js_number(self.size as f64));
        Value::Object(map)
    }
}

impl LandedFile {
    pub fn to_json(&self) -> Value {
        let Value::Object(mut map) = self.file.to_json() else {
            unreachable!("a ref is an object")
        };
        map.insert("path".into(), self.path.clone().into());
        map.insert("landedAt".into(), js_number(self.landed_at));
        Value::Object(map)
    }
}

fn is_sha(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn chars_between(text: &str, min: usize, max: usize) -> bool {
    let n = text.encode_utf16().count();
    n >= min && n <= max
}

fn read_ref(value: &Value) -> Option<AttachmentRef> {
    let fields = object(value)?;
    let sha256 = string(fields, "sha256").filter(|sha| is_sha(sha))?;
    let name = string(fields, "name").filter(|name| chars_between(name, 1, 1000))?;
    let mime_type = string(fields, "mimeType").filter(|mime| chars_between(mime, 1, 200))?;
    let size = fields
        .get("size")?
        .as_f64()
        .filter(|n| n.fract() == 0.0 && *n >= 0.0)?;
    Some(AttachmentRef {
        sha256: sha256.to_owned(),
        name: name.to_owned(),
        mime_type: mime_type.to_owned(),
        size: size as u64,
    })
}

fn read_landed(value: &Value) -> Option<LandedFile> {
    let file = read_ref(value)?;
    let fields = object(value)?;
    let path = string(fields, "path").filter(|path| chars_between(path, 1, 4096))?;
    let landed_at = fields.get("landedAt")?.as_f64()?;
    Some(LandedFile {
        file,
        path: path.to_owned(),
        landed_at,
    })
}

/// An outbox entry's `attachments` field: absent or empty is none; a record that does not read is `Corrupt`.
pub fn read_attached(value: Option<&Value>) -> Attached {
    let Some(value) = value else {
        return Attached::None;
    };
    let Some(fields) = object(value) else {
        return Attached::Corrupt;
    };
    let list = |key: &str| -> Option<Vec<Value>> {
        match fields.get(key) {
            None => Some(Vec::new()),
            Some(Value::Array(items)) => Some(items.clone()),
            Some(_) => None,
        }
    };
    let (Some(images), Some(files)) = (list("images"), list("files")) else {
        return Attached::Corrupt;
    };
    let images: Option<Vec<AttachmentRef>> = images.iter().map(read_ref).collect();
    let files: Option<Vec<LandedFile>> = files.iter().map(read_landed).collect();
    match (images, files) {
        (Some(images), Some(files)) if images.is_empty() && files.is_empty() => Attached::None,
        (Some(images), Some(files)) => Attached::Set(AttachedSet { images, files }),
        _ => Attached::Corrupt,
    }
}

/// One attachment as read: its reference and bytes.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub file: AttachmentRef,
    pub bytes: Arc<Vec<u8>>,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    crate::hex(&Sha256::digest(bytes))
}

/// The same bytes twice are one attachment (the first one's name).
pub fn dedupe_by_sha(list: Vec<Resolved>) -> Vec<Resolved> {
    let mut seen = HashSet::new();
    list.into_iter()
        .filter(|item| seen.insert(item.file.sha256.clone()))
        .collect()
}

/// Which attachments go inline and which land as files. `inline` is false for a receiver that has no omp to hand a
/// picture to (a caller outside OMPdesk): every picture lands as a file.
pub fn plan(resolved: Vec<Resolved>, inline: bool) -> (Vec<Resolved>, Vec<Resolved>) {
    let mut images = Vec::new();
    let mut files = Vec::new();
    let mut budget = INLINE_IMAGE_BUDGET_BYTES;
    for item in resolved {
        if inline && is_image_type(&item.file.mime_type) && item.bytes.len() <= budget {
            budget -= item.bytes.len();
            images.push(item);
        } else {
            files.push(item);
        }
    }
    (images, files)
}

/// One picture's bytes as stock's `ImageContent`.
pub fn image_block(file: &AttachmentRef, bytes: &[u8]) -> Value {
    use base64::Engine;
    json!({
        "type": "image",
        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
        "mimeType": file.mime_type,
    })
}

/// `text` replaced by each moved path's new one.
pub fn move_paths(text: &str, moved: &[(String, String)]) -> String {
    moved
        .iter()
        .fold(text.to_owned(), |text, (from, to)| text.replace(from, to))
}

/// `value` (JSON data) with every moved path replaced in each string it holds.
pub fn move_paths_deep(value: &Value, moved: &[(String, String)]) -> Value {
    match value {
        Value::String(text) => Value::String(move_paths(text, moved)),
        Value::Array(items) => {
            Value::Array(items.iter().map(|v| move_paths_deep(v, moved)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), move_paths_deep(item, moved)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// What keeps a stored message from being delivered with what it promised: a damaged record of its attachments,
/// bytes the store no longer holds, a file that cannot be put on the receiver's computer again. The text alone never
/// goes instead: the entry stays queued and the sender is told what is gone.
#[derive(Debug, Clone, PartialEq)]
pub struct Problem(pub String);

/// Content-addressed bytes of what stored messages carry: in a folder (0600), or in memory without one.
pub struct AttachmentStore {
    dir: Option<PathBuf>,
    now: Clock,
    memory: Mutex<HashMap<String, (Arc<Vec<u8>>, f64)>>,
}

impl AttachmentStore {
    pub fn new(dir: Option<PathBuf>) -> AttachmentStore {
        AttachmentStore::with_clock(dir, system_clock())
    }

    pub fn with_clock(dir: Option<PathBuf>, now: Clock) -> AttachmentStore {
        AttachmentStore {
            dir,
            now,
            memory: Mutex::new(HashMap::new()),
        }
    }

    fn memory(&self) -> std::sync::MutexGuard<'_, HashMap<String, (Arc<Vec<u8>>, f64)>> {
        self.memory
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Keep `bytes`; resolves once they can be read back. The same bytes are one file.
    pub async fn put(self: &Arc<Self>, bytes: Arc<Vec<u8>>) -> Result<String, String> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || store.put_now(&bytes))
            .await
            .map_err(|error| error.to_string())?
    }

    pub fn put_now(&self, bytes: &Arc<Vec<u8>>) -> Result<String, String> {
        let sha = sha256_hex(bytes);
        match &self.dir {
            None => {
                let at = (self.now)();
                self.memory().insert(sha.clone(), (bytes.clone(), at));
            }
            Some(dir) => {
                crate::disk::tree::write_atomic_if(
                    &dir.join(&sha),
                    bytes,
                    Some(0o600),
                    0o700,
                    &|| true,
                )
                .map_err(|fault| fault.message)?;
            }
        }
        Ok(sha)
    }

    /// The bytes named by `sha256`; None when gone or when what is stored does not hash to its name.
    pub async fn get(self: &Arc<Self>, sha256: &str) -> Option<Arc<Vec<u8>>> {
        let store = self.clone();
        let sha256 = sha256.to_owned();
        tokio::task::spawn_blocking(move || store.get_now(&sha256))
            .await
            .ok()
            .flatten()
    }

    pub fn get_now(&self, sha256: &str) -> Option<Arc<Vec<u8>>> {
        if !is_sha(sha256) {
            return None;
        }
        let bytes = match &self.dir {
            Some(dir) => Arc::new(std::fs::read(dir.join(sha256)).ok()?),
            None => self.memory().get(sha256)?.0.clone(),
        };
        (sha256_hex(&bytes) == sha256).then_some(bytes)
    }

    /// Delete what `keep` does not name and is older than the grace; returns how many went.
    pub fn sweep(&self, keep: &HashSet<String>) -> usize {
        let oldest = (self.now)() - ATTACHMENT_SWEEP_GRACE_MS;
        let mut removed = 0;
        let Some(dir) = &self.dir else {
            self.memory().retain(|sha, (_, at)| {
                let drop = !keep.contains(sha) && *at < oldest;
                removed += usize::from(drop);
                !drop
            });
            return removed;
        };
        let Ok(names) = std::fs::read_dir(dir) else {
            return 0;
        };
        for entry in names.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !is_sha(&name) || keep.contains(&name) {
                continue;
            }
            let young = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .is_none_or(|age| age.as_millis() as f64 >= oldest);
            if young {
                continue;
            }
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
        removed
    }
}

/// The paths files landed at on each computer today, so the same bytes are put there once.
#[derive(Default)]
pub struct LandedCache {
    paths: Mutex<HashMap<String, (String, f64)>>,
}

impl LandedCache {
    fn paths(&self) -> std::sync::MutexGuard<'_, HashMap<String, (String, f64)>> {
        self.paths
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Whether a file landed at `landed_at` is still in the store at `now`.
    pub fn fresh(landed_at: f64, now: f64) -> bool {
        now - landed_at < LANDED_FRESH_MS
    }

    pub fn get(&self, device: Option<&str>, sha: &str, now: f64) -> Option<(String, f64)> {
        let key = format!("{}\n{sha}", device.unwrap_or(""));
        let mut paths = self.paths();
        let (path, at) = paths.get(&key)?.clone();
        if !Self::fresh(at, now) {
            paths.remove(&key);
            return None;
        }
        Some((path, at))
    }

    pub fn set(&self, device: Option<&str>, sha: &str, path: &str, now: f64) {
        let mut paths = self.paths();
        paths.retain(|_, (_, at)| Self::fresh(*at, now));
        paths.insert(
            format!("{}\n{sha}", device.unwrap_or("")),
            (path.to_owned(), now),
        );
    }
}
