//! `POST /upload`: a file from the phone (a photo, an attachment) lands on the host so an agent can read it (unit 8b;
//! was `src/main/web/uploads.ts`). Stored at `<userData>/web-uploads/<deviceId>/<uuid>/<name>` (dirs 0700, files
//! 0600), at most 25 MiB each and 200 MiB per device in any 24 hours, and deleted 24 hours after arriving. Revoking a
//! device deletes its folder. The upload counts as the day's use while the file still exists, so the cap needs no
//! ledger and survives a restart. A picture a call names (`take`) is read and deleted at once.
//!
//! One store per `userData` per core process (`open`): the edge's `POST /upload` and main's requests change the same
//! object. Methods (`register`): `web.uploads.store` (+ `bin`), `web.uploads.take` (answers with `bin`),
//! `web.uploads.sweep`, `web.uploads.removeDevice`, and `web.uploads.receive` (the body of a `POST /upload`, as
//! `bin`; what the edge's `Uploads::receive` does, for the parity tests). A refusal is the fault `upload_<status>`.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use http_body_util::BodyExt as _;
use hyper::HeaderMap;
use hyper::Request;
use hyper::body::{Body, Bytes, Incoming};
use hyper::header::{CONTENT_LENGTH, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::json;

use super::deps::{BoxFuture, Upload, UploadFailure, Uploads};
use crate::server::{Call, Fault, Registry, Reply};

pub const FILE_MAX_BYTES: u64 = 25 * 1024 * 1024;
pub const DEVICE_DAILY_MAX_BYTES: u64 = 200 * 1024 * 1024;
pub const TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// Multipart framing around the file: a request may be a little over the file limit.
const MULTIPART_OVERHEAD_BYTES: u64 = 64 * 1024;
/// The folder of files attached to this computer's own tabs with no path here (ipc.ts FS_UPLOAD_TO_HOST).
pub const LOCAL_DEVICE: &str = "this-computer";
const FOLDER: &str = "web-uploads";

/// The caps; a test lowers them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub file_max: u64,
    pub daily_max: u64,
    pub ttl_ms: i64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            file_max: FILE_MAX_BYTES,
            daily_max: DEVICE_DAILY_MAX_BYTES,
            ttl_ms: TTL_MS,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LimitParams {
    file_max_bytes: Option<u64>,
    daily_max_bytes: Option<u64>,
    ttl_ms: Option<i64>,
}

impl LimitParams {
    fn limits(&self) -> Limits {
        let default = Limits::default();
        Limits {
            file_max: self.file_max_bytes.unwrap_or(default.file_max),
            daily_max: self.daily_max_bytes.unwrap_or(default.daily_max),
            ttl_ms: self.ttl_ms.unwrap_or(default.ttl_ms),
        }
    }
}

fn refuse(status: u16, message: &str) -> UploadFailure {
    UploadFailure {
        status,
        message: message.to_owned(),
    }
}

fn io_failure(error: &io::Error) -> UploadFailure {
    eprintln!("ompdesk-core: an upload failed: {error}");
    refuse(500, "internal")
}

struct Inner {
    root: PathBuf,
    /// Bytes of uploads in flight, so parallel requests cannot together pass the daily cap.
    pending: Mutex<HashMap<String, u64>>,
}

#[derive(Clone)]
pub struct UploadStore {
    inner: Arc<Inner>,
}

static STORES: LazyLock<Mutex<HashMap<PathBuf, Arc<UploadStore>>>> = LazyLock::new(Mutex::default);

fn stores() -> MutexGuard<'static, HashMap<PathBuf, Arc<UploadStore>>> {
    STORES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The one store of this `userData` in the process.
pub fn open(user_data: &Path) -> Arc<UploadStore> {
    let root = resolve(&user_data.join(FOLDER));
    Arc::clone(stores().entry(root.clone()).or_insert_with(|| {
        Arc::new(UploadStore {
            inner: Arc::new(Inner {
                root,
                pending: Mutex::default(),
            }),
        })
    }))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as i64)
}

/// `path.resolve`: against the working folder when relative, `.` and `..` folded away without touching the disk.
fn resolve(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                out.push(component);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if out
                    .components()
                    .next_back()
                    .is_some_and(|last| matches!(last, Component::Normal(_)))
                {
                    out.pop();
                }
            }
        }
    }
    out
}

/// `path.join(base, tail)` for a name from outside: its own separators and `..` count, a leading `/` does not
/// replace the base.
fn join(base: &Path, tail: &str) -> PathBuf {
    let mut joined = base.as_os_str().to_owned();
    joined.push(std::path::MAIN_SEPARATOR_STR);
    joined.push(tail);
    resolve(Path::new(&joined))
}

/// Whether `ch` is one `String.prototype.trim` removes (`WhiteSpace` and `LineTerminator`).
fn is_js_space(ch: char) -> bool {
    (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}'
}

/// The last segment of `raw` as node's `path.basename` reads it, backslashes already turned into `/`.
fn basename(raw: &str) -> &str {
    #[cfg(windows)]
    let raw = match raw.as_bytes() {
        [drive, b':', ..] if drive.is_ascii_alphabetic() => &raw[2..],
        _ => raw,
    };
    raw.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

/// One path segment safe to create: no separators or control characters, no leading dots, not too long.
pub fn safe_name(raw: &str) -> String {
    let slashed = raw.replace('\\', "/");
    let cleaned: String = basename(&slashed)
        .chars()
        .filter(|ch| !ch.is_control())
        .collect();
    let cleaned = cleaned.trim_start_matches('.').trim_matches(is_js_space);
    let units: Vec<u16> = cleaned.encode_utf16().collect();
    let name = if units.len() > 200 {
        String::from_utf16_lossy(&units[units.len() - 200..])
    } else {
        cleaned.to_owned()
    };
    if name.is_empty() {
        "upload".to_owned()
    } else {
        name
    }
}

fn entries(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .map(|read| {
            read.filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// `stat(path).mtimeMs`.
fn mtime_ms(path: &Path) -> Option<f64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(match modified.duration_since(UNIX_EPOCH) {
        Ok(since) => since.as_secs_f64() * 1000.0,
        Err(before) => -before.duration().as_secs_f64() * 1000.0,
    })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What an upload in flight has reserved of its device's day, given back when it ends.
struct Reserved {
    inner: Arc<Inner>,
    device: String,
    bytes: u64,
}

impl Drop for Reserved {
    fn drop(&mut self) {
        let mut pending = lock(&self.inner.pending);
        let left = pending
            .get(&self.device)
            .copied()
            .unwrap_or(0)
            .saturating_sub(self.bytes);
        if left > 0 {
            pending.insert(self.device.clone(), left);
        } else {
            pending.remove(&self.device);
        }
    }
}

impl Inner {
    fn device_dir(&self, device: &str) -> PathBuf {
        join(&self.root, device)
    }

    /// Bytes of this device's uploads that still exist and arrived within the TTL.
    fn live_bytes(&self, device: &str, now: i64, ttl_ms: i64) -> u64 {
        let base = self.device_dir(device);
        let mut total = 0;
        for folder in entries(&base) {
            let dir = base.join(&folder);
            let Some(mtime) = mtime_ms(&dir) else {
                continue;
            };
            if now as f64 - mtime > ttl_ms as f64 {
                continue;
            }
            for file in entries(&dir) {
                total += fs::metadata(dir.join(file)).map_or(0, |info| info.len());
            }
        }
        total
    }

    fn write(&self, device: &str, raw_name: &str, bytes: &[u8]) -> io::Result<Upload> {
        let name = safe_name(raw_name);
        let folder = self.device_dir(device).join(uuid());
        make_private_dirs(&folder)?;
        let target = folder.join(&name);
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        options.open(&target)?.write_all(bytes)?;
        Ok(Upload {
            path: target.to_string_lossy().into_owned(),
            name,
            size: bytes.len() as u64,
        })
    }

    fn take(&self, device: &str, file: &str) -> Result<Vec<u8>, UploadFailure> {
        let missing = || refuse(404, "no such upload");
        let target = resolve(Path::new(file));
        let folder = self.device_dir(device);
        // Exactly `<root>/<device>/<uuid>/<name>`, the shape `write` makes.
        let relative: Vec<Component<'_>> = target
            .strip_prefix(&folder)
            .map(|rest| rest.components().collect())
            .unwrap_or_default();
        let [Component::Normal(upload), Component::Normal(_)] = relative.as_slice() else {
            return Err(missing());
        };
        let bytes = fs::read(&target).map_err(|_| missing())?;
        let _ = fs::remove_dir_all(folder.join(upload));
        Ok(bytes)
    }

    /// Delete uploads older than the TTL; returns how many went.
    fn sweep(&self, now: i64, ttl_ms: i64) -> usize {
        let mut removed = 0;
        for device in entries(&self.root) {
            let base = self.root.join(&device);
            for folder in entries(&base) {
                let dir = base.join(&folder);
                if let Some(mtime) = mtime_ms(&dir)
                    && now as f64 - mtime > ttl_ms as f64
                {
                    let _ = fs::remove_dir_all(&dir);
                    removed += 1;
                }
            }
        }
        removed
    }

    fn remove_device(&self, device: &str) {
        let _ = fs::remove_dir_all(self.device_dir(device));
    }
}

/// `mkdir(folder, { recursive: true, mode: 0o700 })`.
fn make_private_dirs(folder: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(folder)
}

/// `randomUUID()`.
fn uuid() -> String {
    let mut bytes = [0; 16];
    if crate::sys::random(&mut bytes).is_err() {
        bytes = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos())
            .to_le_bytes();
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = super::hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    match tokio::task::spawn_blocking(work).await {
        Ok(value) => value,
        Err(error) => std::panic::resume_unwind(error.into_panic()),
    }
}

impl UploadStore {
    /// How much of the device's day is spoken for, reserved before anything is read or written.
    async fn reserve(
        &self,
        device: &str,
        limits: Limits,
        now: i64,
        bytes: impl FnOnce(i64) -> Result<u64, UploadFailure>,
    ) -> Result<(Reserved, i64), UploadFailure> {
        let inner = Arc::clone(&self.inner);
        let name = device.to_owned();
        let live = blocking(move || inner.live_bytes(&name, now, limits.ttl_ms)).await;
        let mut pending = lock(&self.inner.pending);
        let used = live + pending.get(device).copied().unwrap_or(0);
        let room = limits.daily_max as i64 - used as i64;
        let reserve = bytes(room)?;
        *pending.entry(device.to_owned()).or_insert(0) += reserve;
        Ok((
            Reserved {
                inner: Arc::clone(&self.inner),
                device: device.to_owned(),
                bytes: reserve,
            },
            room,
        ))
    }

    async fn write(
        &self,
        device: &str,
        name: &str,
        bytes: Vec<u8>,
    ) -> Result<Upload, UploadFailure> {
        let inner = Arc::clone(&self.inner);
        let (device, name) = (device.to_owned(), name.to_owned());
        blocking(move || inner.write(&device, &name, &bytes))
            .await
            .map_err(|error| io_failure(&error))
    }

    /// A file a paired computer attached to a prompt of a tab it runs here (`host.files.upload`) or this computer's
    /// own tab attached: the same folder, limits and lifetime as a phone's upload.
    pub async fn store(
        &self,
        now: i64,
        limits: Limits,
        device: &str,
        name: &str,
        bytes: Vec<u8>,
    ) -> Result<Upload, UploadFailure> {
        let size = bytes.len() as u64;
        if size == 0 {
            return Err(refuse(400, "empty file"));
        }
        if size > limits.file_max {
            return Err(refuse(413, "file too large"));
        }
        let (_reserved, _) = self
            .reserve(device, limits, now, |room| {
                if size as i64 > room {
                    Err(refuse(429, "daily upload limit reached"))
                } else {
                    Ok(size)
                }
            })
            .await?;
        self.write(device, name, bytes).await
    }

    /// The `POST /upload` body (multipart, field `file`) of a request with these headers, stored.
    pub async fn receive_body<B>(
        &self,
        now: i64,
        limits: Limits,
        device: &str,
        headers: &HeaderMap,
        mut body: B,
    ) -> Result<Upload, UploadFailure>
    where
        B: Body<Data = Bytes> + Unpin,
    {
        let content_type = headers.get(CONTENT_TYPE).map_or_else(String::new, |value| {
            String::from_utf8_lossy(value.as_bytes()).into_owned()
        });
        if !starts_with_ignore_case(&content_type, "multipart/form-data;") {
            return Err(refuse(415, "expected multipart/form-data"));
        }
        let declared = headers.get(CONTENT_LENGTH).and_then(|value| {
            let text = String::from_utf8_lossy(value.as_bytes());
            let text = text.trim();
            if text.is_empty() {
                Some(0.0)
            } else {
                text.parse::<f64>().ok().filter(|number| number.is_finite())
            }
        });
        let limit = limits.file_max + MULTIPART_OVERHEAD_BYTES;
        if declared.is_some_and(|declared| declared > limit as f64) {
            return Err(refuse(413, "file too large"));
        }
        let reserve = declared.map_or(limits.file_max, |declared| {
            declared.min(limit as f64) as u64
        });
        let (_reserved, room) = self
            .reserve(device, limits, now, |room| {
                if room <= 0 {
                    Err(refuse(429, "daily upload limit reached"))
                } else {
                    Ok(reserve)
                }
            })
            .await?;
        let mut data = Vec::new();
        while let Some(frame) = body.frame().await {
            let Ok(frame) = frame else {
                return Err(refuse(400, "malformed upload"));
            };
            if let Ok(chunk) = frame.into_data() {
                if (data.len() + chunk.len()) as u64 > limit {
                    return Err(refuse(413, "file too large"));
                }
                data.extend_from_slice(&chunk);
            }
        }
        let file = parse_multipart(&content_type, &data)
            .map_err(|()| refuse(400, "malformed upload"))?
            .ok_or_else(|| refuse(400, "missing file field"))?;
        let size = (file.end - file.start) as u64;
        if size > limits.file_max {
            return Err(refuse(413, "file too large"));
        }
        if size as i64 > room {
            return Err(refuse(429, "daily upload limit reached"));
        }
        let bytes = data[file.start..file.end].to_vec();
        self.write(device, &file.name, bytes).await
    }

    /// The bytes of `file`, an upload of this device that a call names, and the upload is gone. 404 when it is not
    /// this device's or no longer there.
    pub async fn take(&self, device: &str, file: &str) -> Result<Vec<u8>, UploadFailure> {
        let inner = Arc::clone(&self.inner);
        let (device, file) = (device.to_owned(), file.to_owned());
        blocking(move || inner.take(&device, &file)).await
    }

    /// Delete uploads older than the TTL; returns how many went.
    pub async fn sweep(&self, now: i64, ttl_ms: i64) -> usize {
        let inner = Arc::clone(&self.inner);
        blocking(move || inner.sweep(now, ttl_ms)).await
    }

    /// Delete everything a device uploaded (it was revoked).
    pub async fn remove_device(&self, device: &str) {
        let inner = Arc::clone(&self.inner);
        let device = device.to_owned();
        blocking(move || inner.remove_device(&device)).await;
    }
}

/// How much of a refused upload's body is read out before the socket is let go: a little over what the edge ever takes.
const REFUSED_DRAIN_MAX_BYTES: usize = 64 * 1024 * 1024;

impl Uploads for UploadStore {
    fn receive(
        &self,
        device_id: &str,
        request: Request<Incoming>,
    ) -> BoxFuture<'_, Result<Upload, UploadFailure>> {
        let device = device_id.to_owned();
        Box::pin(async move {
            let (parts, mut body) = request.into_parts();
            let stored = self
                .receive_body(now_ms(), Limits::default(), &device, &parts.headers, &mut body)
                .await;
            if stored.is_err() {
                // What a refused upload did not read is read out, as node's server dumped it: a socket closed with
                // unread data resets, and the page then never sees the 413 or 429.
                let mut left = REFUSED_DRAIN_MAX_BYTES;
                while let Some(Ok(frame)) = body.frame().await {
                    let read = frame.data_ref().map_or(0, Bytes::len);
                    if read >= left {
                        break;
                    }
                    left -= read;
                }
            }
            stored
        })
    }
}

fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.len() >= prefix.len()
        && text.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// Where a form's `file` entry sits in the body.
#[derive(Debug, PartialEq, Eq)]
struct FilePart {
    name: String,
    start: usize,
    end: usize,
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
}

/// The parameters of a header value, `;`-separated, a quoted value read whole.
fn params(value: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = value;
    while !rest.is_empty() {
        let (item, tail) = match split_outside_quotes(rest) {
            Some(at) => (&rest[..at], &rest[at + 1..]),
            None => (rest, ""),
        };
        rest = tail;
        if let Some((key, raw)) = item.split_once('=') {
            let raw = raw.trim();
            let value = match raw.strip_prefix('"') {
                Some(quoted) => {
                    let mut text = String::new();
                    let mut chars = quoted.chars();
                    while let Some(ch) = chars.next() {
                        match ch {
                            '"' => break,
                            '\\' => text.extend(chars.next()),
                            other => text.push(other),
                        }
                    }
                    text
                }
                None => raw.to_owned(),
            };
            out.push((key.trim().to_ascii_lowercase(), value));
        }
    }
    out
}

fn split_outside_quotes(text: &str) -> Option<usize> {
    let mut quoted = false;
    let mut escaped = false;
    for (at, ch) in text.char_indices() {
        match ch {
            _ if escaped => escaped = false,
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            ';' if !quoted => return Some(at),
            _ => {}
        }
    }
    None
}

/// The first form entry named `file` when it is a file; `Ok(None)` when there is none or it is a plain value, `Err`
/// for a body that is no multipart form.
fn parse_multipart(content_type: &str, body: &[u8]) -> Result<Option<FilePart>, ()> {
    let boundary = params(content_type.split_once(';').map_or("", |(_, rest)| rest))
        .into_iter()
        .find_map(|(key, value)| (key == "boundary").then_some(value))
        .filter(|boundary| !boundary.is_empty())
        .ok_or(())?;
    let delimiter = format!("--{boundary}").into_bytes();
    let next = [b"\r\n".as_slice(), &delimiter].concat();
    // Anything before the first delimiter is a preamble.
    let mut at = {
        let mut from = 0;
        loop {
            let found = find(body, &delimiter, from).ok_or(())?;
            if found == 0 || body[..found].ends_with(b"\r\n") {
                break found;
            }
            from = found + 1;
        }
    } + delimiter.len();
    let mut first_file = None;
    loop {
        if body[at..].starts_with(b"--") {
            return Ok(first_file.flatten());
        }
        while matches!(body.get(at), Some(b' ' | b'\t')) {
            at += 1;
        }
        if !body[at..].starts_with(b"\r\n") {
            return Err(());
        }
        at += 2;
        let (headers, start) = if body[at..].starts_with(b"\r\n") {
            (&body[at..at], at + 2)
        } else {
            let end = find(body, b"\r\n\r\n", at).ok_or(())?;
            (&body[at..end], end + 4)
        };
        let end = find(body, &next, start).ok_or(())?;
        let disposition = String::from_utf8_lossy(headers)
            .split("\r\n")
            .map(|line| line.split_once(':').ok_or(()))
            .collect::<Result<Vec<_>, ()>>()?
            .into_iter()
            .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-disposition"))
            .map(|(_, value)| value.to_owned())
            .ok_or(())?;
        let kind = disposition.split(';').next().unwrap_or("").trim();
        if !kind.eq_ignore_ascii_case("form-data") {
            return Err(());
        }
        let fields = params(disposition.split_once(';').map_or("", |(_, rest)| rest));
        let field = |key: &str| {
            fields
                .iter()
                .find_map(|(name, value)| (name == key).then(|| value.clone()))
        };
        let name = field("name").ok_or(())?;
        if first_file.is_none() && name == "file" {
            first_file = Some(field("filename").map(|name| FilePart { name, start, end }));
        }
        at = end + next.len();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    user_data: PathBuf,
    #[serde(default)]
    device_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    file: String,
    #[serde(default)]
    now: Option<i64>,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    content_length: Option<f64>,
    #[serde(default)]
    limits: LimitParams,
}

impl Params {
    fn of(call: &Call) -> Result<Params, Fault> {
        call.params()
    }

    fn now(&self) -> i64 {
        self.now.unwrap_or_else(now_ms)
    }
}

fn fault(failure: &UploadFailure) -> Fault {
    Fault::new(
        format!("upload_{}", failure.status),
        failure.message.clone(),
    )
}

async fn store(mut call: Call) -> Result<Reply, Fault> {
    let params = Params::of(&call)?;
    let bytes = call.bin.take().unwrap_or_default();
    let upload = open(&params.user_data)
        .store(
            params.now(),
            params.limits.limits(),
            &params.device_id,
            &params.name,
            bytes,
        )
        .await
        .map_err(|failure| fault(&failure))?;
    Reply::json(&json!({ "path": upload.path, "name": upload.name, "size": upload.size }))
}

async fn take(call: Call) -> Result<Reply, Fault> {
    let params = Params::of(&call)?;
    let bytes = open(&params.user_data)
        .take(&params.device_id, &params.file)
        .await
        .map_err(|failure| fault(&failure))?;
    Ok(Reply::json(&json!({}))?.with_bin(bytes))
}

async fn sweep(call: Call) -> Result<Reply, Fault> {
    let params = Params::of(&call)?;
    let removed = open(&params.user_data)
        .sweep(params.now(), params.limits.limits().ttl_ms)
        .await;
    Reply::json(&json!({ "removed": removed }))
}

async fn remove_device(call: Call) -> Result<Reply, Fault> {
    let params = Params::of(&call)?;
    open(&params.user_data)
        .remove_device(&params.device_id)
        .await;
    Reply::json(&json!({}))
}

/// The edge's `receive` over a body main hands in: `contentType` and `contentLength` as the request's headers
/// gave them (`contentLength` absent when the request declared none).
async fn receive(mut call: Call) -> Result<Reply, Fault> {
    let params = Params::of(&call)?;
    let mut headers = HeaderMap::new();
    if let Some(value) = params
        .content_type
        .as_deref()
        .and_then(|value| value.parse().ok())
    {
        headers.insert(CONTENT_TYPE, value);
    }
    if let Some(length) = params.content_length {
        headers.insert(
            CONTENT_LENGTH,
            length
                .to_string()
                .parse()
                .map_err(|_| Fault::new("invalid_params", "contentLength is not a header value"))?,
        );
    }
    let body = http_body_util::Full::new(Bytes::from(call.bin.take().unwrap_or_default()));
    let upload = open(&params.user_data)
        .receive_body(
            params.now(),
            params.limits.limits(),
            &params.device_id,
            &headers,
            body,
        )
        .await
        .map_err(|failure| fault(&failure))?;
    Reply::json(&json!({ "path": upload.path, "name": upload.name, "size": upload.size }))
}

pub fn register(registry: &mut Registry) {
    registry.add("web.uploads.store", |call| Box::pin(store(call)));
    registry.add("web.uploads.take", |call| Box::pin(take(call)));
    registry.add("web.uploads.sweep", |call| Box::pin(sweep(call)));
    registry.add("web.uploads.removeDevice", |call| {
        Box::pin(remove_device(call))
    });
    registry.add("web.uploads.receive", |call| Box::pin(receive(call)));
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            static COUNT: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "ompdesk-core-uploads-{}-{}",
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

    /// `unwrap` for a refusal, which carries no `Debug`.
    trait Fine<T> {
        fn fine(self) -> T;
    }

    impl<T> Fine<T> for Result<T, UploadFailure> {
        fn fine(self) -> T {
            match self {
                Ok(value) => value,
                Err(failure) => panic!("refused {}: {}", failure.status, failure.message),
            }
        }
    }

    const SMALL: Limits = Limits {
        file_max: 1000,
        daily_max: 2500,
        ttl_ms: TTL_MS,
    };

    /// A browser's form body: one part, `name` the field, `file` its file name.
    fn form(field: &str, file: &str, bytes: &[u8]) -> (String, Vec<u8>) {
        let boundary = "----WebKitFormBoundaryTest";
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{file}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        (format!("multipart/form-data; boundary={boundary}"), body)
    }

    fn headers(content_type: &str, length: Option<usize>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, content_type.parse().unwrap());
        if let Some(length) = length {
            headers.insert(CONTENT_LENGTH, length.to_string().parse().unwrap());
        }
        headers
    }

    async fn receive(
        store: &UploadStore,
        device: &str,
        (content_type, body): (String, Vec<u8>),
        declare: bool,
    ) -> Result<Upload, UploadFailure> {
        let length = declare.then_some(body.len());
        store
            .receive_body(
                now_ms(),
                SMALL,
                device,
                &headers(&content_type, length),
                http_body_util::Full::new(Bytes::from(body)),
            )
            .await
    }

    fn status<T>(result: &Result<T, UploadFailure>) -> u16 {
        match result {
            Ok(_) => 0,
            Err(failure) => failure.status,
        }
    }

    #[test]
    fn a_name_is_one_safe_path_segment() {
        for (raw, expected) in [
            ("photo.jpg", "photo.jpg"),
            ("../../etc/passwd", "passwd"),
            ("C:\\Users\\me\\a b.png", "a b.png"),
            (".hidden", "hidden"),
            ("...", "upload"),
            ("a\0b\nc.txt", "abc.txt"),
            ("", "upload"),
            ("/", "upload"),
            ("dir/", "dir"),
            ("  spaced  ", "spaced"),
            ("\u{feff}bom.txt\u{feff}", "bom.txt"),
            ("\u{85}x", "x"),
            ("한글 이름.png", "한글 이름.png"),
        ] {
            assert_eq!(safe_name(raw), expected, "{raw:?}");
        }
        assert_eq!(safe_name(&"x".repeat(300)).len(), 200);
        let long = format!("{}z", "😀".repeat(150));
        assert_eq!(safe_name(&long).encode_utf16().count(), 200);
        assert!(safe_name(&long).ends_with('z'));
    }

    #[tokio::test]
    async fn a_file_lands_under_device_uuid_name_with_owner_only_modes() {
        let scratch = Scratch::new();
        let store = open(&scratch.0);
        let stored = receive(&store, "dev1", form("file", "pic.png", &[1, 2, 3]), true)
            .await
            .fine();
        assert_eq!((stored.name.as_str(), stored.size), ("pic.png", 3));
        let path = PathBuf::from(&stored.path);
        assert!(path.starts_with(scratch.0.join(FOLDER).join("dev1")));
        assert_eq!(fs::read(&path).unwrap(), [1, 2, 3]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(path.parent().unwrap()), 0o700);
            assert_eq!(mode(path.parent().unwrap().parent().unwrap()), 0o700);
        }
        assert!(
            Arc::ptr_eq(&store, &open(&scratch.0)),
            "one store per userData"
        );
    }

    #[tokio::test]
    async fn a_name_never_leaves_its_folder() {
        let scratch = Scratch::new();
        let stored = receive(
            &open(&scratch.0),
            "dev1",
            form("file", "../../evil.sh", &[1]),
            true,
        )
        .await
        .fine();
        assert_eq!(stored.name, "evil.sh");
        assert!(PathBuf::from(&stored.path).starts_with(scratch.0.join(FOLDER).join("dev1")));
    }

    #[tokio::test]
    async fn a_file_over_the_cap_is_refused_by_its_declared_length_and_by_what_arrives() {
        let scratch = Scratch::new();
        let store = open(&scratch.0);
        let big = receive(&store, "dev1", form("file", "big.bin", &[0; 1001]), true).await;
        assert_eq!(status(&big), 413);
        assert_eq!(big.err().unwrap().message, "file too large");
        let huge = receive(
            &store,
            "dev1",
            form("file", "huge.bin", &vec![0; 101_000]),
            false,
        )
        .await;
        assert_eq!(status(&huge), 413);
        assert!(!scratch.0.join(FOLDER).join("dev1").exists());
        // Past the cap but within the multipart framing's allowance: the file itself is judged.
        let framed = receive(&store, "dev1", form("file", "f.bin", &[0; 1001]), false).await;
        assert_eq!(status(&framed), 413);
    }

    #[tokio::test]
    async fn a_body_that_is_not_a_multipart_form_is_refused() {
        let scratch = Scratch::new();
        let store = open(&scratch.0);
        let json = store
            .receive_body(
                now_ms(),
                SMALL,
                "dev1",
                &headers("application/json", Some(2)),
                http_body_util::Full::new(Bytes::from_static(b"{}")),
            )
            .await;
        assert_eq!(
            (status(&json), json.err().unwrap().message.as_str()),
            (415, "expected multipart/form-data")
        );
        let other = receive(&store, "dev1", form("other", "a.txt", &[1]), true).await;
        assert_eq!(
            (status(&other), other.err().unwrap().message.as_str()),
            (400, "missing file field")
        );
        let (content_type, mut body) = form("file", "a.txt", &[1]);
        body.truncate(body.len() - 8);
        let cut = receive(&store, "dev1", (content_type.clone(), body), true).await;
        assert_eq!(
            (status(&cut), cut.err().unwrap().message.as_str()),
            (400, "malformed upload")
        );
        let no_boundary = receive(
            &store,
            "dev1",
            ("multipart/form-data; charset=utf-8".to_owned(), Vec::new()),
            true,
        )
        .await;
        assert_eq!(status(&no_boundary), 400);
        let plain = receive(
            &store,
            "dev1",
            (
                content_type,
                b"------WebKitFormBoundaryTest\r\nContent-Disposition: form-data; name=\"file\"\r\n\r\ntext\r\n------WebKitFormBoundaryTest--\r\n"
                    .to_vec(),
            ),
            true,
        )
        .await;
        assert_eq!(
            (status(&plain), plain.err().unwrap().message.as_str()),
            (400, "missing file field")
        );
    }

    #[tokio::test]
    async fn a_device_may_upload_its_day_and_a_restart_does_not_reset_it() {
        let scratch = Scratch::new();
        let store = open(&scratch.0);
        let chunk = [0; 900];
        receive(&store, "dev1", form("file", "a", &chunk), true)
            .await
            .fine();
        receive(&store, "dev1", form("file", "b", &chunk), true)
            .await
            .fine();
        let third = receive(&store, "dev1", form("file", "c", &chunk), true).await;
        assert_eq!(
            (status(&third), third.err().unwrap().message.as_str()),
            (429, "daily upload limit reached")
        );
        receive(&store, "dev2", form("file", "a", &chunk), true)
            .await
            .fine();
        let restarted = UploadStore {
            inner: Arc::new(Inner {
                root: store.inner.root.clone(),
                pending: Mutex::default(),
            }),
        };
        let again = receive(&restarted, "dev1", form("file", "c", &chunk), true).await;
        assert_eq!(status(&again), 429);
        // A file that only fits once the room is counted: 2 x 900 used, 700 left.
        let store3 = open(&Scratch::new().0);
        receive(&store3, "d", form("file", "a", &chunk), true)
            .await
            .fine();
        receive(&store3, "d", form("file", "b", &chunk), true)
            .await
            .fine();
        let small = receive(&store3, "d", form("file", "c", &[0; 701]), true).await;
        assert_eq!(status(&small), 429);
        receive(&store3, "d", form("file", "c", &[0; 700]), true)
            .await
            .fine();
    }

    #[tokio::test]
    async fn parallel_uploads_cannot_together_pass_the_daily_cap() {
        let scratch = Scratch::new();
        let store = open(&scratch.0);
        let results = futures_join(
            (0..4)
                .map(|index| {
                    let store = Arc::clone(&store);
                    tokio::spawn(async move {
                        receive(
                            &store,
                            "dev1",
                            form("file", &format!("p{index}"), &[0; 900]),
                            true,
                        )
                        .await
                    })
                })
                .collect(),
        )
        .await;
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 2);
    }

    async fn futures_join<T: Send + 'static>(tasks: Vec<tokio::task::JoinHandle<T>>) -> Vec<T> {
        let mut out = Vec::new();
        for task in tasks {
            out.push(task.await.unwrap());
        }
        out
    }

    #[tokio::test]
    async fn store_keeps_a_file_a_paired_computer_attached_under_the_same_rules() {
        let scratch = Scratch::new();
        let store = open(&scratch.0);
        let kept = store
            .store(now_ms(), SMALL, LOCAL_DEVICE, "clip.bin", vec![1, 0, 2])
            .await
            .fine();
        assert!(kept.path.contains(LOCAL_DEVICE));
        assert_eq!(fs::read(&kept.path).unwrap(), [1, 0, 2]);
        let empty = store.store(now_ms(), SMALL, "d", "e", Vec::new()).await;
        assert_eq!(
            (status(&empty), empty.err().unwrap().message.as_str()),
            (400, "empty file")
        );
        let big = store.store(now_ms(), SMALL, "d", "b", vec![0; 1001]).await;
        assert_eq!(status(&big), 413);
        store
            .store(now_ms(), SMALL, "d", "a", vec![0; 1000])
            .await
            .fine();
        store
            .store(now_ms(), SMALL, "d", "b", vec![0; 1000])
            .await
            .fine();
        let spent = store.store(now_ms(), SMALL, "d", "c", vec![0; 1000]).await;
        assert_eq!(status(&spent), 429);
    }

    #[cfg(unix)]
    fn age(path: &Path, to: i64) {
        let at = UNIX_EPOCH + std::time::Duration::from_millis(to as u64);
        fs::File::open(path).unwrap().set_modified(at).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn uploads_go_after_24_hours_and_a_revoked_device_loses_everything() {
        let scratch = Scratch::new();
        let store = open(&scratch.0);
        let now = 1_900_000_000_000;
        let old = store
            .store(now, Limits::default(), "dev1", "old", vec![1])
            .await
            .fine();
        let fresh = store
            .store(now, Limits::default(), "dev1", "fresh", vec![1])
            .await
            .fine();
        let folder = |upload: &Upload| PathBuf::from(&upload.path).parent().unwrap().to_path_buf();
        age(&folder(&old), now - TTL_MS - 5_000);
        age(&folder(&fresh), now);
        assert_eq!(store.sweep(now + 1_000, TTL_MS).await, 1);
        assert!(!PathBuf::from(&old.path).exists());
        assert!(PathBuf::from(&fresh.path).exists());
        // Bytes of a folder past the TTL no longer count against the day.
        age(&folder(&fresh), now - TTL_MS - 5_000);
        assert_eq!(store.inner.live_bytes("dev1", now, TTL_MS), 0);
        store.remove_device("dev1").await;
        assert!(!scratch.0.join(FOLDER).join("dev1").exists());
        store.remove_device("dev1").await;
    }

    #[tokio::test]
    async fn a_call_takes_its_devices_upload_once_and_the_upload_is_gone() {
        let scratch = Scratch::new();
        let store = open(&scratch.0);
        let stored = receive(&store, "dev1", form("file", "image.jpeg", &[7, 8, 9]), true)
            .await
            .fine();
        assert_eq!(status(&store.take("dev2", &stored.path).await), 404);
        assert!(PathBuf::from(&stored.path).exists());
        assert_eq!(store.take("dev1", &stored.path).await.fine(), [7, 8, 9]);
        assert!(!PathBuf::from(&stored.path).parent().unwrap().exists());
        let again = store.take("dev1", &stored.path).await;
        assert_eq!(
            (status(&again), again.err().unwrap().message.as_str()),
            (404, "no such upload")
        );
        let root = scratch.0.join(FOLDER);
        for path in [
            root.join("dev1"),
            root.join("dev1/uuid"),
            root.join("dev1/..").join("dev2/x/y"),
            root.join("dev1/a/b/c"),
        ] {
            assert_eq!(
                status(&store.take("dev1", &path.to_string_lossy()).await),
                404,
                "{path:?}"
            );
        }
    }

    #[test]
    fn a_form_is_read_as_a_browser_writes_it() {
        let body = b"preamble\r\n--b\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\nhi\r\n--b\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a \\\"q\\\".txt\"\r\nContent-Type: text/plain\r\n\r\nline1\r\n--not\r\nline2\r\n--b--\r\nepilogue";
        let found = parse_multipart("multipart/form-data; boundary=\"b\"", body)
            .unwrap()
            .unwrap();
        assert_eq!(found.name, "a \"q\".txt");
        assert_eq!(&body[found.start..found.end], b"line1\r\n--not\r\nline2");
        assert_eq!(
            parse_multipart("multipart/form-data; boundary=b", b"--b--"),
            Ok(None)
        );
        assert_eq!(
            parse_multipart("multipart/form-data; boundary=b", b"nothing"),
            Err(())
        );
        assert_eq!(parse_multipart("multipart/form-data;", b"--b--"), Err(()));
    }
}
