//! The `gui_visualize` tool's pure rules (`src/main/preview/visuals.ts`, `preview-check.ts`): the visual store
//! (records on disk, which tab shows which, what an `omp-visual:` request may read), the tool's argument schema and
//! every text the agent reads back, and the two pure rules of the Preview check. The CEF glue owns the pages, the
//! clock (`now_ms`) and the check's timing; `VISUALIZE_DEFINITION` stays in TypeScript.
//!
//! `history.json` is read as the TypeScript wrote it and written in the same shape (field names and order, integer
//! millisecond timestamps), so an existing user's file keeps working both ways.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::js;
use super::urls::{VISUAL_SCHEME, parse_visual_url, preview_url};

/// Visuals one tab keeps open at once.
const TAB_VISUALS: usize = 8;
const MAX_VERSIONS: usize = 20;
const MAX_RECORDS: usize = 100;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
/// How long `choose` waits when the agent names no timeout.
pub const CHOICE_DEFAULT_SECONDS: u64 = 120;
pub const CHOICE_MAX_SECONDS: u64 = 600;
/// The longer side of the picture sent to the judge (`PREVIEW_CHECK_IMAGE_MAX`).
pub const PREVIEW_CHECK_IMAGE_MAX: u32 = 1280;

/// Files the preview can show as a visual's entry, with the type they are served as.
const ENTRY_TYPES: &[(&str, &str)] = &[
    (".html", "text/html"),
    (".htm", "text/html"),
    (".svg", "image/svg+xml"),
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".gif", "image/gif"),
    (".webp", "image/webp"),
    (".avif", "image/avif"),
    (".txt", "text/plain"),
];
/// The only other files a page may read (by extension), besides the entry types.
const EXTRA_ASSET_TYPES: &[(&str, &str)] = &[
    (".css", "text/css"),
    (".js", "text/javascript"),
    (".mjs", "text/javascript"),
    (".json", "application/json"),
    (".ico", "image/x-icon"),
    (".woff", "font/woff"),
    (".woff2", "font/woff2"),
    (".ttf", "font/ttf"),
    (".otf", "font/otf"),
    (".mp4", "video/mp4"),
    (".webm", "video/webm"),
    (".mp3", "audio/mpeg"),
    (".wav", "audio/wav"),
    (".wasm", "application/wasm"),
    (".md", "text/plain"),
];

fn entry_type(ext: &str) -> Option<&'static str> {
    ENTRY_TYPES.iter().find(|(e, _)| *e == ext).map(|(_, t)| *t)
}

fn asset_type(ext: &str) -> Option<&'static str> {
    entry_type(ext).or_else(|| {
        EXTRA_ASSET_TYPES
            .iter()
            .find(|(e, _)| *e == ext)
            .map(|(_, t)| *t)
    })
}

/// The policy on every `omp-visual:` response: a page loads only from its own origin and `data:`/`blob:`.
pub const VISUAL_CSP: &str = "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; \
style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; \
connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; \
form-action 'none'";

/// A refusal `open` reports; its text is what the agent reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisualError(pub String);

impl std::fmt::Display for VisualError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn refuse<T>(text: impl Into<String>) -> Result<T, VisualError> {
    Err(VisualError(text.into()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Inline,
    Url,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionRecord {
    pub version: u64,
    pub created_at: u64,
    /// Snapshot file name in the visual's folder; "" for a web address.
    pub file: String,
    pub hash: String,
}

/// One visual as `history.json` keeps it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualRecord {
    pub id: String,
    pub label: String,
    pub kind: Kind,
    /// Absolute file path or web address ("" inline).
    pub target: String,
    pub cwd: String,
    /// Folder its other files load from (the tab folder, or the visual's own for inline HTML).
    pub root: String,
    /// The entry's path under `root`, `/`-separated.
    pub entry: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub versions: Vec<VersionRecord>,
}

/// `PreviewVisualRecord`: a row of "All visuals".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    pub id: String,
    pub label: String,
    pub kind: Kind,
    pub target: String,
    pub cwd: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub versions: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionStamp {
    pub version: u64,
    pub created_at: u64,
}

/// `PreviewVisualView`: a visual as one page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualView {
    pub id: String,
    pub label: String,
    pub version: u64,
    pub versions: Vec<VersionStamp>,
}

/// An `omp-visual:` response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Served {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// What `open` was asked (the tool's `open` arguments, trimmed and checked by `parse_tool_args`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpenInput {
    pub target: Option<String>,
    pub html: Option<String>,
    pub label: Option<String>,
    pub visual: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    pub record: VisualRecord,
    pub version: u64,
    pub added: bool,
}

/// `path.extname(..).toLowerCase()`: from the last dot of the last segment, "" for no dot or a leading one.
fn ext(path: &str) -> String {
    let base = path.rsplit(['/', '\\']).next().unwrap_or("");
    match base.rfind('.') {
        Some(i) if i > 0 && base != ".." => base[i..].to_lowercase(),
        _ => String::new(),
    }
}

/// `path.resolve(base, rel)` without touching the disk: join, then drop `.` and fold `..`.
fn resolve_path(base: &Path, rel: &str) -> PathBuf {
    normalize(&base.join(rel))
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `inside` of the TypeScript: `path.relative(root, candidate)` is empty or neither starts with `..` nor is absolute.
fn inside(root: &Path, candidate: &Path) -> bool {
    let (root, candidate) = (normalize(root), normalize(candidate));
    match candidate.strip_prefix(&root) {
        Ok(rest) => rest
            .components()
            .next()
            .is_none_or(|first| !first.as_os_str().to_string_lossy().starts_with("..")),
        Err(_) => false,
    }
}

fn lossy(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `encodeURIComponent`.
fn encode_component(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `decodeURIComponent`; None where it throws (a bad `%` sequence, or bytes that are not UTF-8).
fn decode_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn random_id() -> Result<String, VisualError> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|e| VisualError(format!("random id: {e}")))?;
    Ok(hex(&bytes))
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Replace `file` with `data` in one step: a sibling temp file, renamed over it. Windows refuses a rename onto a held
/// file (EPERM/EACCES/EBUSY): that is tried again a few times (about 0.6 s in all); elsewhere a refusal is real.
fn write_file_atomic(file: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = PathBuf::from(format!(
        "{}.{}-{}.tmp",
        file.display(),
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&temp, data)?;
    let mut waits = [10u64, 20, 40, 80, 160, 320].into_iter();
    loop {
        match std::fs::rename(&temp, file) {
            Ok(()) => return Ok(()),
            Err(error) => {
                let blocked = cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied;
                match waits.next().filter(|_| blocked) {
                    Some(ms) => std::thread::sleep(std::time::Duration::from_millis(ms)),
                    None => {
                        let _ = std::fs::remove_file(&temp);
                        return Err(error);
                    }
                }
            }
        }
    }
}

/// The visuals of this computer: records on disk, which tabs show which, and file serving for the scheme.
/// `history.json` is read in `new` (the TypeScript read it at first use; nothing here can run before that).
pub struct VisualStore {
    dir: PathBuf,
    records: Vec<VisualRecord>,
    by_tab: HashMap<String, Vec<String>>,
}

impl VisualStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        let dir = dir.into();
        // A missing, unreadable or malformed file (or a record with a bad id) leaves the store empty.
        let records = std::fs::read_to_string(dir.join("history.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<Vec<VisualRecord>>(&text).ok())
            .filter(|all| all.iter().all(|r| is_id(&r.id)))
            .unwrap_or_default();
        Self {
            dir,
            records,
            by_tab: HashMap::new(),
        }
    }

    fn save(&self) -> std::io::Result<()> {
        let text = serde_json::to_string(&self.records).map_err(std::io::Error::other)?;
        write_file_atomic(&self.dir.join("history.json"), text.as_bytes())
    }

    fn record(&self, id: &str) -> Option<&VisualRecord> {
        self.records.iter().find(|r| r.id == id)
    }

    /// "All visuals", newest first.
    pub fn list(&self) -> Vec<ListEntry> {
        self.records
            .iter()
            .map(|r| ListEntry {
                id: r.id.clone(),
                label: r.label.clone(),
                kind: r.kind,
                target: r.target.clone(),
                cwd: r.cwd.clone(),
                created_at: r.created_at,
                updated_at: r.updated_at,
                versions: r.versions.len(),
            })
            .collect()
    }

    pub fn for_tab(&self, tab: &str) -> Vec<String> {
        self.by_tab.get(tab).cloned().unwrap_or_default()
    }

    /// Show a visual from "All visuals" in `tab` too.
    pub fn add_to_tab(&mut self, tab: &str, id: &str) -> bool {
        if self.record(id).is_none() {
            return false;
        }
        let ids = self.by_tab.entry(tab.to_owned()).or_default();
        if !ids.iter().any(|e| e == id) {
            ids.push(id.to_owned());
            let extra = ids.len().saturating_sub(TAB_VISUALS);
            ids.drain(..extra);
        }
        true
    }

    pub fn remove_from_tab(&mut self, tab: &str, id: &str) {
        self.by_tab
            .entry(tab.to_owned())
            .or_default()
            .retain(|e| e != id);
    }

    pub fn forget_tab(&mut self, tab: &str) {
        self.by_tab.remove(tab);
    }

    pub fn view(&self, id: &str, version: Option<u64>) -> Option<VisualView> {
        let record = self.record(id)?;
        let latest = record.versions.last().map_or(0, |v| v.version);
        let shown = version
            .filter(|v| *v != 0 && record.versions.iter().any(|e| e.version == *v))
            .unwrap_or(latest);
        Some(VisualView {
            id: id.to_owned(),
            label: record.label.clone(),
            version: shown,
            versions: if record.kind == Kind::Url {
                Vec::new()
            } else {
                record
                    .versions
                    .iter()
                    .map(|v| VersionStamp {
                        version: v.version,
                        created_at: v.created_at,
                    })
                    .collect()
            },
        })
    }

    /// The address a page loads for `version` (default latest).
    pub fn url(&self, id: &str, version: Option<u64>) -> Option<String> {
        let record = self.record(id)?;
        if record.kind == Kind::Url {
            return Some(record.target.clone());
        }
        let shown = self.view(id, version).map_or(0, |v| v.version);
        let path: Vec<String> = record.entry.split('/').map(encode_component).collect();
        Some(format!(
            "{VISUAL_SCHEME}://v{shown}-{id}/{}",
            path.join("/")
        ))
    }

    /// Which visual and version an `omp-visual:` address names, or None.
    pub fn parse(&self, url: &str) -> Option<(String, u64)> {
        parse_visual_url(url)
    }

    /// The file an `omp-visual:` request reads and its type, or None (unknown visual, outside its folder, missing).
    pub fn resolve(&self, url: &str) -> Option<(PathBuf, &'static str)> {
        let (id, version_no) = self.parse(url)?;
        let record = self.record(&id)?;
        if record.kind == Kind::Url {
            return None;
        }
        let parsed = url::Url::parse(url).ok()?;
        let decoded = decode_component(parsed.path())?;
        let relative = decoded.trim_start_matches('/');
        if relative == record.entry {
            let version = record.versions.iter().find(|v| v.version == version_no)?;
            if version.file.is_empty() {
                return None;
            }
            let kind = entry_type(&ext(&record.entry)).unwrap_or("text/html");
            return Some((self.dir.join(&record.id).join(&version.file), kind));
        }
        if record.kind == Kind::Inline {
            return None;
        }
        if relative.split('/').any(|segment| segment.starts_with('.')) {
            return None;
        }
        let kind = asset_type(&ext(relative))?;
        // Assets come from the entry's own folder (the tab folder when the entry sits at its root), not the whole
        // tab folder: a page cannot read the project's other `.json`/`.js`/`.txt` files.
        let root = Path::new(&record.root);
        let mut entry_path = root.to_path_buf();
        entry_path.extend(record.entry.split('/'));
        let folder = entry_path.parent()?.to_path_buf();
        let candidate = resolve_path(root, relative);
        if !inside(&folder, &candidate) {
            return None;
        }
        let real = std::fs::canonicalize(&candidate).ok()?;
        if !inside(&folder, &real) || !std::fs::metadata(&real).ok()?.is_file() {
            return None;
        }
        if asset_type(&ext(&lossy(&real))) != Some(kind) {
            return None;
        }
        Some((real, kind))
    }

    /// The response for an `omp-visual:` request: the file `resolve` allows, or 404; both limited to the page's own origin.
    pub fn serve(&self, url: &str) -> Served {
        let found = self
            .resolve(url)
            .and_then(|(file, kind)| std::fs::read(file).ok().map(|body| (body, kind)));
        let mut headers = vec![
            ("Content-Security-Policy".to_owned(), VISUAL_CSP.to_owned()),
            ("Cache-Control".to_owned(), "no-store".to_owned()),
            ("X-Content-Type-Options".to_owned(), "nosniff".to_owned()),
        ];
        match found {
            None => {
                headers.push((
                    "Content-Type".to_owned(),
                    "text/plain; charset=utf-8".to_owned(),
                ));
                Served {
                    status: 404,
                    headers,
                    body: b"Not found".to_vec(),
                }
            }
            Some((body, kind)) => {
                let kind = if kind.starts_with("text/") {
                    format!("{kind}; charset=utf-8")
                } else {
                    kind.to_owned()
                };
                headers.push(("Content-Type".to_owned(), kind));
                Served {
                    status: 200,
                    headers,
                    body,
                }
            }
        }
    }

    /// `open`: a new visual or a new version of the tab's matching one. `now_ms` is the clock in milliseconds.
    pub fn open(
        &mut self,
        tab: &str,
        cwd: &str,
        input: &OpenInput,
        now_ms: u64,
    ) -> Result<Opened, VisualError> {
        let has_target = input.target.as_deref().is_some_and(|s| !s.is_empty());
        let has_html = input.html.as_deref().is_some_and(|s| !s.is_empty());
        if has_target == has_html {
            return refuse("Give either target or html");
        }
        let tab_ids = self.for_tab(tab);
        let kind: Kind;
        let mut target = String::new();
        let mut root = String::new();
        let mut entry = "index.html".to_owned();
        let content: Option<Vec<u8>>;
        let raw = input.target.clone().unwrap_or_default();
        if let Some(html) = &input.html {
            kind = Kind::Inline;
            if html.len() > MAX_HTML_BYTES {
                return refuse("html is larger than 2 MB");
            }
            content = Some(html.clone().into_bytes());
        } else if is_web_address(&raw) {
            kind = Kind::Url;
            content = None;
            match preview_url(&raw) {
                Some(url) => target = url,
                None => return refuse(format!("Not a web address the preview opens: {raw}")),
            }
        } else {
            kind = Kind::File;
            let Ok(real_cwd) = std::fs::canonicalize(cwd) else {
                return refuse(format!("The working directory is unavailable: {cwd}"));
            };
            let Ok(real) = std::fs::canonicalize(resolve_path(Path::new(cwd), &raw)) else {
                return refuse(format!("No such file: {raw}"));
            };
            if !inside(&real_cwd, &real) {
                return refuse(format!("{raw} is outside the working directory"));
            }
            let meta = std::fs::metadata(&real).map_err(|e| VisualError(e.to_string()))?;
            if !meta.is_file() {
                return refuse(format!("{raw} is not a file"));
            }
            if entry_type(&ext(&lossy(&real))).is_none() {
                return refuse("visualize shows .html, .htm, .svg, .txt and image files");
            }
            if meta.len() > MAX_FILE_BYTES {
                return refuse(format!("{raw} is larger than 5 MB"));
            }
            content = Some(std::fs::read(&real).map_err(|e| VisualError(e.to_string()))?);
            target = lossy(&real);
            root = lossy(&real_cwd);
            let rest = real.strip_prefix(&real_cwd).unwrap_or(&real);
            entry = rest
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
        }
        let own: Vec<&VisualRecord> = tab_ids.iter().filter_map(|id| self.record(id)).collect();
        let wanted = input.visual.as_deref().filter(|v| !v.is_empty());
        let matched = wanted
            .and_then(|id| own.iter().find(|c| c.id == id))
            .or_else(|| {
                own.iter().find(|c| {
                    if kind == Kind::Inline {
                        c.kind == Kind::Inline
                            && input.label.as_deref().is_some_and(|l| c.label == l)
                    } else {
                        c.kind == kind && c.target == target
                    }
                })
            })
            .map(|r| r.id.clone());
        if let (Some(id), None) = (wanted, &matched) {
            return refuse(format!("No visual {id} in this tab"));
        }
        if let Some(id) = &matched {
            let existing = self.record(id).map(|r| r.kind);
            if existing != Some(kind) {
                return refuse(format!("Visual {id} shows a different kind of target"));
            }
        }
        let mut retargeted = false;
        let id = match matched {
            None => {
                if own.len() >= TAB_VISUALS {
                    return refuse(format!(
                        "This tab already shows {TAB_VISUALS} visuals; close one first"
                    ));
                }
                let id = random_id()?;
                let label = match &input.label {
                    Some(label) => label.clone(),
                    None => match kind {
                        Kind::Url => url_host(&target),
                        Kind::File => Path::new(&target)
                            .file_name()
                            .map_or_else(String::new, |n| lossy(n.as_ref())),
                        Kind::Inline => "Visual".to_owned(),
                    },
                };
                self.records.insert(
                    0,
                    VisualRecord {
                        id: id.clone(),
                        label,
                        kind,
                        target: target.clone(),
                        cwd: cwd.to_owned(),
                        root: if kind == Kind::Inline {
                            lossy(&self.dir.join(&id))
                        } else {
                            root.clone()
                        },
                        entry: entry.clone(),
                        created_at: now_ms,
                        updated_at: now_ms,
                        versions: Vec::new(),
                    },
                );
                self.by_tab
                    .entry(tab.to_owned())
                    .or_default()
                    .push(id.clone());
                id
            }
            Some(id) => {
                // A reused visual shows what this call named: its address or file moved with it, so the next open of
                // the new target finds this record instead of adding a second one.
                let at = self.records.iter().position(|r| r.id == id).unwrap_or(0);
                let mut record = self.records.remove(at);
                retargeted = record.target != target;
                record.target = target.clone();
                if let Some(label) = input.label.as_deref().filter(|l| !l.is_empty()) {
                    record.label = label.to_owned();
                }
                if kind == Kind::File {
                    record.root = root.clone();
                    record.entry = entry.clone();
                }
                self.records.insert(0, record);
                id
            }
        };
        let hash = match &content {
            Some(bytes) => hex(&Sha256::digest(bytes)),
            None => target.clone(),
        };
        let dir = self.dir.join(&id);
        let io = |e: std::io::Error| VisualError(e.to_string());
        let record = &mut self.records[0];
        let last = record.versions.last().cloned();
        let mut added = false;
        if last.as_ref().is_none_or(|l| l.hash != hash) || retargeted {
            let version = last.map_or(0, |l| l.version) + 1;
            let mut file = String::new();
            if let Some(bytes) = &content {
                file = format!(
                    "v{version}{}",
                    if kind == Kind::Inline {
                        ".html".to_owned()
                    } else {
                        ext(&record.entry)
                    }
                );
                std::fs::create_dir_all(&dir).map_err(io)?;
                std::fs::write(dir.join(&file), bytes).map_err(io)?;
            }
            record.versions.push(VersionRecord {
                version,
                created_at: now_ms,
                file,
                hash,
            });
            if kind == Kind::Url {
                let drop = record.versions.len() - 1;
                record.versions.drain(..drop);
            }
            let extra = record.versions.len().saturating_sub(MAX_VERSIONS);
            for dropped in record.versions.drain(..extra) {
                if !dropped.file.is_empty() {
                    let _ = std::fs::remove_file(dir.join(&dropped.file));
                }
            }
            added = true;
        }
        record.updated_at = now_ms;
        let opened = Opened {
            version: record.versions.last().map_or(1, |v| v.version),
            record: record.clone(),
            added,
        };
        if self.records.len() > MAX_RECORDS {
            for dropped in self.records.split_off(MAX_RECORDS) {
                let _ = std::fs::remove_dir_all(self.dir.join(&dropped.id));
            }
        }
        self.save().map_err(io)?;
        Ok(opened)
    }
}

fn is_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `/^https?:\/\//i`.
fn is_web_address(raw: &str) -> bool {
    let lower = raw.get(..8).map(str::to_ascii_lowercase);
    let head = raw.get(..7).map(str::to_ascii_lowercase);
    head.as_deref() == Some("http://") || lower.as_deref() == Some("https://")
}

/// `new URL(target).host`: the host and a non-default port.
fn url_host(target: &str) -> String {
    let Ok(url) = url::Url::parse(target) else {
        return String::new();
    };
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

// ---- the tool ----

/// A parsed `gui_visualize` call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolArgs {
    Open(OpenInput),
    Check {
        visual: String,
    },
    Choose {
        visual: String,
        timeout_seconds: Option<u64>,
    },
    Close {
        visual: String,
    },
}

/// What the agent reads, and whether it failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolText {
    pub text: String,
    pub is_error: bool,
}

fn answer(text: impl Into<String>, is_error: bool) -> ToolText {
    ToolText {
        text: text.into(),
        is_error,
    }
}

/// One zod (v3) issue: its keys in the order zod writes them.
struct Issue(Vec<(&'static str, Value)>);

impl Issue {
    fn render(&self) -> String {
        let fields: Vec<String> = self
            .0
            .iter()
            .map(|(key, value)| {
                let body = serde_json::to_string_pretty(value)
                    .unwrap_or_default()
                    .replace('\n', "\n    ");
                format!("    \"{key}\": {body}")
            })
            .collect();
        format!("  {{\n{}\n  }}", fields.join(",\n"))
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn invalid_type(expected: &str, found: &Value, path: Vec<Value>) -> Issue {
    let received = type_name(found);
    Issue(vec![
        ("code", "invalid_type".into()),
        ("expected", expected.into()),
        ("received", received.into()),
        ("path", Value::Array(path)),
        (
            "message",
            if received == "undefined" {
                "Required".into()
            } else {
                format!("Expected {expected}, received {received}").into()
            },
        ),
    ])
}

fn required(expected: &str, key: &str) -> Issue {
    Issue(vec![
        ("code", "invalid_type".into()),
        ("expected", expected.into()),
        ("received", "undefined".into()),
        ("path", Value::Array(vec![key.into()])),
        ("message", "Required".into()),
    ])
}

/// `z.string()` with the checks `trim`, `min`, `max` the schema names; `max` counts UTF-16 units as zod does.
fn string_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
    trim: bool,
    min: usize,
    max: Option<usize>,
    issues: &mut Vec<Issue>,
) -> Option<String> {
    let value = object.get(key)?;
    let Some(text) = value.as_str() else {
        issues.push(invalid_type("string", value, vec![key.into()]));
        return None;
    };
    let text = if trim {
        text.trim_matches(js::is_space)
    } else {
        text
    };
    let units = text.encode_utf16().count();
    if units < min {
        issues.push(Issue(vec![
            ("code", "too_small".into()),
            ("minimum", min.into()),
            ("type", "string".into()),
            ("inclusive", true.into()),
            ("exact", false.into()),
            (
                "message",
                format!("String must contain at least {min} character(s)").into(),
            ),
            ("path", Value::Array(vec![key.into()])),
        ]));
        return None;
    }
    if let Some(max) = max.filter(|m| units > *m) {
        issues.push(Issue(vec![
            ("code", "too_big".into()),
            ("maximum", max.into()),
            ("type", "string".into()),
            ("inclusive", true.into()),
            ("exact", false.into()),
            (
                "message",
                format!("String must contain at most {max} character(s)").into(),
            ),
            ("path", Value::Array(vec![key.into()])),
        ]));
        return None;
    }
    Some(text.to_owned())
}

fn visual_field(
    object: &serde_json::Map<String, Value>,
    issues: &mut Vec<Issue>,
) -> Option<String> {
    match object.get("visual") {
        None => {
            issues.push(required("string", "visual"));
            None
        }
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => {
            issues.push(invalid_type("string", other, vec!["visual".into()]));
            None
        }
    }
}

/// The zod schema of `runVisualizeTool`. The error is the text the agent reads after "Invalid gui_visualize
/// arguments: " (zod's `error.message`, the issues as pretty-printed JSON). The common issue kinds (type, size,
/// integer range, unknown action) are reproduced; zod's text for any other malformed shape is not.
pub fn parse_tool_args(args: &Value) -> Result<ToolArgs, String> {
    let wrap = |issues: Vec<Issue>| {
        let body: Vec<String> = issues.iter().map(Issue::render).collect();
        format!("[\n{}\n]", body.join(",\n"))
    };
    let Some(object) = args.as_object() else {
        return Err(wrap(vec![invalid_type("object", args, Vec::new())]));
    };
    let mut issues = Vec::new();
    let action = object.get("action").and_then(Value::as_str);
    let parsed = match action {
        Some("open") => {
            let target = string_field(object, "target", true, 1, Some(4096), &mut issues);
            let html = string_field(object, "html", false, 1, None, &mut issues);
            let label = string_field(object, "label", true, 1, Some(120), &mut issues);
            let visual = match object.get("visual") {
                None => None,
                Some(Value::String(text)) => Some(text.clone()),
                Some(other) => {
                    issues.push(invalid_type("string", other, vec!["visual".into()]));
                    None
                }
            };
            ToolArgs::Open(OpenInput {
                target,
                html,
                label,
                visual,
            })
        }
        Some("check") => ToolArgs::Check {
            visual: visual_field(object, &mut issues).unwrap_or_default(),
        },
        Some("close") => ToolArgs::Close {
            visual: visual_field(object, &mut issues).unwrap_or_default(),
        },
        Some("choose") => {
            let visual = visual_field(object, &mut issues).unwrap_or_default();
            ToolArgs::Choose {
                visual,
                timeout_seconds: timeout_field(object, &mut issues),
            }
        }
        _ => {
            return Err(wrap(vec![Issue(vec![
                ("code", "invalid_union_discriminator".into()),
                (
                    "options",
                    Value::Array(vec![
                        "open".into(),
                        "check".into(),
                        "choose".into(),
                        "close".into(),
                    ]),
                ),
                ("path", Value::Array(vec!["action".into()])),
                (
                    "message",
                    "Invalid discriminator value. Expected 'open' | 'check' | 'choose' | 'close'"
                        .into(),
                ),
            ])]));
        }
    };
    if issues.is_empty() {
        Ok(parsed)
    } else {
        Err(wrap(issues))
    }
}

/// `z.number().int().min(10).max(600).optional()`: every failing check reports.
fn timeout_field(object: &serde_json::Map<String, Value>, issues: &mut Vec<Issue>) -> Option<u64> {
    let value = object.get("timeout_seconds")?;
    let path = || Value::Array(vec!["timeout_seconds".into()]);
    let Some(number) = value.as_f64() else {
        issues.push(invalid_type(
            "number",
            value,
            vec!["timeout_seconds".into()],
        ));
        return None;
    };
    let before = issues.len();
    if number.fract() != 0.0 {
        issues.push(Issue(vec![
            ("code", "invalid_type".into()),
            ("expected", "integer".into()),
            ("received", "float".into()),
            ("message", "Expected integer, received float".into()),
            ("path", path()),
        ]));
    }
    if number < 10.0 {
        issues.push(Issue(vec![
            ("code", "too_small".into()),
            ("minimum", 10.into()),
            ("type", "number".into()),
            ("inclusive", true.into()),
            ("exact", false.into()),
            (
                "message",
                "Number must be greater than or equal to 10".into(),
            ),
            ("path", path()),
        ]));
    }
    if number > CHOICE_MAX_SECONDS as f64 {
        issues.push(Issue(vec![
            ("code", "too_big".into()),
            ("maximum", CHOICE_MAX_SECONDS.into()),
            ("type", "number".into()),
            ("inclusive", true.into()),
            ("exact", false.into()),
            ("message", "Number must be less than or equal to 600".into()),
            ("path", path()),
        ]));
    }
    (issues.len() == before).then_some(number as u64)
}

/// The tool's answer to arguments `parse_tool_args` refused.
pub fn invalid_args_text(error: &str) -> ToolText {
    answer(format!("Invalid gui_visualize arguments: {error}"), true)
}

/// How long `choose` waits, in milliseconds.
pub fn choose_timeout_ms(timeout_seconds: Option<u64>) -> u64 {
    timeout_seconds.unwrap_or(CHOICE_DEFAULT_SECONDS) * 1000
}

/// What the judge saw on a just-opened page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Error,
    Blank,
}

/// What the agent reads under the tool result (`previewHint`).
pub fn preview_hint(problem: Verdict) -> String {
    let seen = match problem {
        Verdict::Error => "the page shows an error message.",
        Verdict::Blank => "the page looks blank (nothing rendered).",
    };
    format!("Preview check: {seen} Look at it with gui_visualize or fix the page.")
}

/// The text of a successful `open`.
pub fn open_text(
    record: &VisualRecord,
    version: u64,
    added: bool,
    problem: Option<Verdict>,
) -> ToolText {
    let version_text = if record.kind == Kind::Url {
        String::new()
    } else {
        format!(
            ", version {version}{}",
            if added { "" } else { " (unchanged)" }
        )
    };
    let hint = problem.map_or_else(String::new, |p| format!("\n{}", preview_hint(p)));
    answer(
        format!(
            "Showing \"{}\" in the user's Preview panel (visual {}{version_text}). \
The user may comment on it; their comments come as a message.{hint}",
            record.label, record.id
        ),
        false,
    )
}

/// A refusal of `open` as the agent reads it.
pub fn error_text(error: &VisualError) -> ToolText {
    answer(error.0.clone(), true)
}

/// The visual is not one this tab shows.
pub fn not_in_tab_text(visual: &str) -> ToolText {
    answer(format!("No visual {visual} in this tab"), true)
}

pub fn close_text(visual: &str) -> ToolText {
    answer(format!("Closed visual {visual}."), false)
}

/// A console error or warning of the shown page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub level: String,
    pub message: String,
    /// Script URL, "" when the page gave none.
    pub source: String,
    pub line: u64,
}

/// What the preview reports about the page that shows a visual.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageInfo {
    pub title: String,
    pub url: String,
    pub loading: bool,
    pub problems: Vec<Problem>,
}

/// The text of `check`: the page's title, address, loading state and console problems; None page = off screen.
pub fn check_text(page: Option<&PageInfo>) -> ToolText {
    let Some(page) = page else {
        return answer(
            "The visual is not on screen now (its tab or the Preview panel is closed).",
            false,
        );
    };
    let problems = if page.problems.is_empty() {
        "No console errors or warnings.".to_owned()
    } else {
        page.problems
            .iter()
            .map(|p| {
                let at = if p.source.is_empty() {
                    String::new()
                } else {
                    format!(" ({}:{})", p.source, p.line)
                };
                format!("- {}: {}{at}", p.level, p.message)
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let title = if page.title.is_empty() {
        "(none)"
    } else {
        &page.title
    };
    let loading = if page.loading { "\nStill loading." } else { "" };
    answer(
        format!("Title: {title}\nAddress: {}{loading}\n{problems}", page.url),
        false,
    )
}

/// The user's `data-choice` pick, or why there is none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Choice {
    Picked {
        value: String,
        text: String,
    },
    /// No page shows the visual.
    None,
    Timeout,
    Closed,
    /// The agent's browser drives that page.
    Agent,
}

pub fn choose_text(choice: &Choice) -> ToolText {
    match choice {
        Choice::None => answer(
            "The visual is not on screen, so the user cannot choose now.",
            true,
        ),
        Choice::Agent => answer(
            "Your browser tool is driving that page; choices count only from the user.",
            true,
        ),
        Choice::Timeout => answer("The user did not choose in time.", false),
        Choice::Closed => answer("The visual was closed before the user chose.", false),
        Choice::Picked { value, text } => {
            let text = if text.is_empty() {
                String::new()
            } else {
                format!(" ({text})")
            };
            answer(format!("The user chose \"{value}\"{text}."), false)
        }
    }
}

/// `judgeImage`'s size rule: None when a capture of `width` x `height` goes to the judge as it is, else the size it is
/// resized to so its longer side is `PREVIEW_CHECK_IMAGE_MAX` (each side at least 1).
pub fn judge_image_size(width: u32, height: u32) -> Option<(u32, u32)> {
    let longer = f64::from(width.max(height));
    let max = f64::from(PREVIEW_CHECK_IMAGE_MAX);
    if longer <= max {
        return None;
    }
    let side = |n: u32| js::max(1.0, js::round(f64::from(n) * max / longer)) as u32;
    Some((side(width), side(height)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Dirs {
        root: PathBuf,
        project: PathBuf,
    }

    impl Drop for Dirs {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    static UNIQUE: AtomicU64 = AtomicU64::new(0);

    fn setup() -> (Dirs, VisualStore) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "omp-visuals-{}-{nanos}-{}",
            std::process::id(),
            UNIQUE.fetch_add(1, Ordering::Relaxed)
        ));
        let project = root.join("project");
        std::fs::create_dir_all(project.join("site").join("assets")).unwrap();
        std::fs::write(
            project.join("site").join("index.html"),
            "<title>One</title>",
        )
        .unwrap();
        std::fs::write(
            project.join("site").join("assets").join("app.css"),
            "body{}",
        )
        .unwrap();
        std::fs::write(project.join(".env"), "SECRET=1").unwrap();
        std::fs::write(project.join("notes.bin"), "x").unwrap();
        std::fs::write(root.join("outside.css"), "nope").unwrap();
        let store = VisualStore::new(root.join("visuals"));
        (Dirs { root, project }, store)
    }

    fn target(path: &str) -> OpenInput {
        OpenInput {
            target: Some(path.to_owned()),
            ..Default::default()
        }
    }

    fn open(store: &mut VisualStore, d: &Dirs, input: &OpenInput) -> Result<Opened, VisualError> {
        store.open("tab", &lossy(&d.project), input, 1_700_000_000_000)
    }

    fn header<'a>(served: &'a Served, name: &str) -> &'a str {
        served
            .headers
            .iter()
            .find(|(k, _)| k == name)
            .map_or("", |(_, v)| v)
    }

    #[test]
    fn keeps_a_version_per_change_and_serves_each_snapshot_and_the_folders_assets() {
        let (d, mut store) = setup();
        let first = open(&mut store, &d, &target("site/index.html")).unwrap();
        assert_eq!((first.version, first.added), (1, true));
        let again = open(&mut store, &d, &target("site/index.html")).unwrap();
        assert_eq!((again.version, again.added), (1, false));
        std::fs::write(
            d.project.join("site").join("index.html"),
            "<title>Two</title>",
        )
        .unwrap();
        let second = open(&mut store, &d, &target("./site/index.html")).unwrap();
        assert_eq!(second.record.id, first.record.id);
        assert_eq!((second.version, second.added), (2, true));

        let id = first.record.id;
        let view = store.view(&id, None).unwrap();
        assert_eq!(view.label, "index.html");
        assert_eq!(view.version, 2);
        assert_eq!(
            view.versions.iter().map(|v| v.version).collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(store.view(&id, Some(1)).unwrap().version, 1);
        let v1 = store.url(&id, Some(1)).unwrap();
        assert_eq!(v1, format!("omp-visual://v1-{id}/site/index.html"));
        assert_eq!(store.parse(&v1), Some((id.clone(), 1)));
        let (file, kind) = store.resolve(&v1).unwrap();
        assert_eq!(kind, "text/html");
        assert_eq!(std::fs::read_to_string(file).unwrap(), "<title>One</title>");
        let (latest, _) = store.resolve(&store.url(&id, None).unwrap()).unwrap();
        assert_eq!(
            std::fs::read_to_string(latest).unwrap(),
            "<title>Two</title>"
        );
        let css = store
            .resolve(&format!("omp-visual://v2-{id}/site/assets/app.css"))
            .unwrap();
        assert_eq!(css.1, "text/css");
    }

    #[cfg(unix)]
    #[test]
    fn never_serves_hidden_files_unknown_types_paths_outside_the_folder_or_symlinks_out_of_it() {
        let (d, mut store) = setup();
        let id = open(&mut store, &d, &target("site/index.html"))
            .unwrap()
            .record
            .id;
        let at = |store: &VisualStore, relative: &str| {
            store.resolve(&format!("omp-visual://v1-{id}/{relative}"))
        };
        assert!(at(&store, ".env").is_none());
        assert!(at(&store, "notes.bin").is_none());
        assert!(at(&store, "../outside.css").is_none());
        assert!(at(&store, "%2E%2E/outside.css").is_none());
        std::os::unix::fs::symlink(
            d.root.join("outside.css"),
            d.project.join("site").join("link.css"),
        )
        .unwrap();
        assert!(at(&store, "site/link.css").is_none());
        assert!(
            store
                .resolve("omp-visual://v1-0000000000000000/site/index.html")
                .is_none()
        );
        assert!(store.resolve("https://example.com/").is_none());
    }

    #[test]
    fn serves_assets_only_from_the_entry_files_folder_or_the_whole_folder_when_the_entry_sits_at_its_root()
     {
        let (d, mut store) = setup();
        std::fs::create_dir_all(d.project.join("config")).unwrap();
        std::fs::write(d.project.join("config").join("credentials.json"), "{}").unwrap();
        std::fs::write(d.project.join("data.json"), "{}").unwrap();
        std::fs::write(d.project.join("site").join("data.json"), "{}").unwrap();
        std::fs::write(d.project.join("home.html"), "<title>Home</title>").unwrap();
        let site = open(&mut store, &d, &target("site/index.html"))
            .unwrap()
            .record
            .id;
        let at = |store: &VisualStore, id: &str, relative: &str| {
            store.resolve(&format!("omp-visual://v1-{id}/{relative}"))
        };
        assert_eq!(
            at(&store, &site, "site/data.json").unwrap().1,
            "application/json"
        );
        assert_eq!(
            at(&store, &site, "site/assets/app.css").unwrap().1,
            "text/css"
        );
        // Siblings of the entry's folder stay out of reach, wherever the page asks for them.
        assert!(at(&store, &site, "data.json").is_none());
        assert!(at(&store, &site, "config/credentials.json").is_none());
        assert!(at(&store, &site, "site/../data.json").is_none());
        let home = open(&mut store, &d, &target("home.html"))
            .unwrap()
            .record
            .id;
        assert_eq!(
            at(&store, &home, "data.json").unwrap().1,
            "application/json"
        );
        assert_eq!(
            at(&store, &home, "config/credentials.json").unwrap().1,
            "application/json"
        );
        assert!(at(&store, &home, ".env").is_none());
    }

    #[test]
    fn limits_what_a_visuals_page_can_request_to_its_own_origin_on_every_response() {
        let (d, mut store) = setup();
        let id = open(&mut store, &d, &target("site/index.html"))
            .unwrap()
            .record
            .id;
        let responses = [
            store.serve(&format!("omp-visual://v1-{id}/site/index.html")),
            store.serve(&format!("omp-visual://v1-{id}/site/assets/app.css")),
            store.serve(&format!("omp-visual://v1-{id}/.env")),
            store.serve("omp-visual://v1-0000000000000000/site/index.html"),
        ];
        assert_eq!(
            responses.iter().map(|r| r.status).collect::<Vec<_>>(),
            [200, 200, 404, 404]
        );
        for response in &responses {
            let policy = header(response, "Content-Security-Policy");
            let directive = |name: &str| -> Vec<&str> {
                policy
                    .split(';')
                    .map(str::trim)
                    .find_map(|part| {
                        let mut words = part.split_whitespace();
                        (words.next() == Some(name)).then(|| words.collect())
                    })
                    .unwrap_or_default()
            };
            assert_eq!(directive("default-src"), ["'none'"]);
            assert_eq!(directive("connect-src"), ["'self'", "data:", "blob:"]);
            assert_eq!(directive("form-action"), ["'none'"]);
            assert_eq!(directive("frame-src"), ["'none'"]);
            assert_eq!(directive("object-src"), ["'none'"]);
            // No directive may allow a remote origin.
            assert!(
                !policy.contains("http:") && !policy.contains("https:") && !policy.contains('*')
            );
            assert_eq!(header(response, "X-Content-Type-Options"), "nosniff");
            assert_eq!(header(response, "Cache-Control"), "no-store");
        }
        assert_eq!(
            header(&responses[0], "Content-Type"),
            "text/html; charset=utf-8"
        );
        assert_eq!(responses[0].body, b"<title>One</title>");
        assert_eq!(
            header(&responses[1], "Content-Type"),
            "text/css; charset=utf-8"
        );
        assert_eq!(responses[2].body, b"Not found");
        assert_eq!(
            header(&responses[2], "Content-Type"),
            "text/plain; charset=utf-8"
        );
    }

    #[test]
    fn points_a_reused_visual_at_the_target_it_was_opened_with_now() {
        let (d, mut store) = setup();
        std::fs::write(
            d.project.join("site").join("two.html"),
            "<title>Two</title>",
        )
        .unwrap();
        let first = open(
            &mut store,
            &d,
            &OpenInput {
                label: Some("Mock".into()),
                ..target("site/index.html")
            },
        )
        .unwrap();
        let moved = open(
            &mut store,
            &d,
            &OpenInput {
                visual: Some(first.record.id.clone()),
                ..target("site/two.html")
            },
        )
        .unwrap();
        assert_eq!(moved.record.id, first.record.id);
        assert_eq!((moved.version, moved.added), (2, true));
        let real = std::fs::canonicalize(d.project.join("site").join("two.html")).unwrap();
        assert_eq!(moved.record.target, lossy(&real));
        assert_eq!(
            store.url(&first.record.id, None).unwrap(),
            format!("omp-visual://v2-{}/site/two.html", first.record.id)
        );
        // Opening the new path again finds the same visual instead of adding a second one.
        let again = open(&mut store, &d, &target("site/two.html")).unwrap();
        assert_eq!(again.record.id, first.record.id);
        assert!(!again.added);
        assert_eq!(store.list().len(), 1);

        let web = open(&mut store, &d, &target("https://example.com/a")).unwrap();
        let next = open(
            &mut store,
            &d,
            &OpenInput {
                visual: Some(web.record.id.clone()),
                ..target("https://example.com/b")
            },
        )
        .unwrap();
        assert_eq!(next.record.id, web.record.id);
        assert!(next.added);
        assert_eq!(
            store.url(&web.record.id, None).unwrap(),
            "https://example.com/b"
        );
        assert_eq!(
            open(&mut store, &d, &target("https://example.com/b"))
                .unwrap()
                .record
                .id,
            web.record.id
        );
        assert_eq!(store.list().len(), 2);
    }

    #[test]
    fn refuses_files_outside_the_working_directory_and_other_types() {
        let (d, mut store) = setup();
        let text =
            |input: OpenInput, store: &mut VisualStore| open(store, &d, &input).unwrap_err().0;
        let outside = text(target("../outside.css"), &mut store);
        assert!(
            outside.contains("outside") || outside.contains("shows"),
            "{outside}"
        );
        assert!(text(target("site/assets/app.css"), &mut store).contains("shows"));
        assert!(text(target("missing.html"), &mut store).contains("No such file"));
        assert!(text(OpenInput::default(), &mut store).contains("either target or html"));
    }

    #[test]
    fn keeps_inline_html_by_label_web_addresses_without_versions_and_history_across_instances() {
        let (d, mut store) = setup();
        let inline = open(
            &mut store,
            &d,
            &OpenInput {
                html: Some("<p>a</p>".into()),
                label: Some("Chart".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let inline2 = open(
            &mut store,
            &d,
            &OpenInput {
                html: Some("<p>b</p>".into()),
                label: Some("Chart".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(inline2.record.id, inline.record.id);
        assert_eq!(inline2.version, 2);
        assert!(
            store
                .resolve(&format!(
                    "omp-visual://v2-{}/assets/x.css",
                    inline.record.id
                ))
                .is_none()
        );
        let web = open(&mut store, &d, &target("https://example.com/a")).unwrap();
        assert_eq!(
            store.url(&web.record.id, None).unwrap(),
            "https://example.com/a"
        );
        assert!(
            store
                .view(&web.record.id, None)
                .unwrap()
                .versions
                .is_empty()
        );
        assert!(open(&mut store, &d, &target("javascript:alert(1)")).is_err());

        let mut reloaded = VisualStore::new(d.root.join("visuals"));
        let list = reloaded.list();
        assert_eq!(
            list.iter().map(|e| e.label.as_str()).collect::<Vec<_>>(),
            ["example.com", "Chart"]
        );
        assert_eq!((list[1].kind, list[1].versions), (Kind::Inline, 2));
        // A new launch knows the visuals but no tab shows them until one is opened again.
        assert!(reloaded.for_tab("tab").is_empty());
        assert!(reloaded.add_to_tab("tab", &inline.record.id));
        assert_eq!(reloaded.for_tab("tab"), [inline.record.id]);
    }

    #[test]
    fn history_json_keeps_the_typescripts_shape() {
        let (d, mut store) = setup();
        let id = open(&mut store, &d, &target("site/index.html"))
            .unwrap()
            .record
            .id;
        let text = std::fs::read_to_string(d.root.join("visuals").join("history.json")).unwrap();
        let real = std::fs::canonicalize(&d.project).unwrap();
        let entry = d.project.join("site").join("index.html");
        let hash = hex(&Sha256::digest(b"<title>One</title>"));
        let want = format!(
            "[{{\"id\":\"{id}\",\"label\":\"index.html\",\"kind\":\"file\",\"target\":{},\"cwd\":{},\"root\":{},\
\"entry\":\"site/index.html\",\"createdAt\":1700000000000,\"updatedAt\":1700000000000,\
\"versions\":[{{\"version\":1,\"createdAt\":1700000000000,\"file\":\"v1.html\",\"hash\":\"{hash}\"}}]}}]",
            serde_json::to_string(&lossy(&std::fs::canonicalize(entry).unwrap())).unwrap(),
            serde_json::to_string(&lossy(&d.project)).unwrap(),
            serde_json::to_string(&lossy(&real)).unwrap(),
        );
        assert_eq!(text, want);
        // Records the TypeScript wrote are read back as they are; a bad id leaves the store empty.
        assert_eq!(VisualStore::new(d.root.join("visuals")).list().len(), 1);
        std::fs::write(
            d.root.join("visuals").join("history.json"),
            text.replace(&id, "XYZ"),
        )
        .unwrap();
        assert!(VisualStore::new(d.root.join("visuals")).list().is_empty());
    }

    #[test]
    fn caps_versions_records_and_tab_visuals() {
        let (d, mut store) = setup();
        for n in 0..25 {
            let html = format!("<p>{n}</p>");
            let r = store
                .open(
                    "tab",
                    "/",
                    &OpenInput {
                        html: Some(html),
                        label: Some("L".into()),
                        ..Default::default()
                    },
                    1,
                )
                .unwrap();
            assert_eq!(r.version, n + 1);
        }
        let id = store.for_tab("tab")[0].clone();
        assert_eq!(store.view(&id, None).unwrap().versions.len(), 20);
        assert!(!d.root.join("visuals").join(&id).join("v1.html").exists());
        for n in 0..8 {
            let label = format!("tab{n}");
            let r = store.open(
                "full",
                "/",
                &OpenInput {
                    html: Some("<p/>".into()),
                    label: Some(label),
                    ..Default::default()
                },
                1,
            );
            assert_eq!(r.is_ok(), n < 8);
        }
        let ninth = store.open(
            "full",
            "/",
            &OpenInput {
                html: Some("<p/>".into()),
                label: Some("nine".into()),
                ..Default::default()
            },
            1,
        );
        assert_eq!(
            ninth.unwrap_err().0,
            "This tab already shows 8 visuals; close one first"
        );
        for n in 0..110 {
            let tab = format!("t{n}");
            store
                .open(
                    &tab,
                    "/",
                    &OpenInput {
                        html: Some("<p/>".into()),
                        ..Default::default()
                    },
                    1,
                )
                .unwrap();
        }
        assert_eq!(store.list().len(), 100);
    }

    fn args(value: Value) -> Result<ToolArgs, String> {
        parse_tool_args(&value)
    }

    #[test]
    fn parses_the_tool_arguments_as_the_schema_does() {
        assert_eq!(
            args(json!({"action": "open", "target": "  a.html "})).unwrap(),
            ToolArgs::Open(OpenInput {
                target: Some("a.html".into()),
                ..Default::default()
            })
        );
        assert_eq!(
            args(json!({"action": "check", "visual": "x"})).unwrap(),
            ToolArgs::Check { visual: "x".into() }
        );
        assert_eq!(
            args(json!({"action": "choose", "visual": "x", "timeout_seconds": 10})).unwrap(),
            ToolArgs::Choose {
                visual: "x".into(),
                timeout_seconds: Some(10)
            }
        );
        assert_eq!(
            args(json!({"action": "close", "visual": "x", "extra": 1})).unwrap(),
            ToolArgs::Close { visual: "x".into() }
        );
        assert!(
            args(json!({"action": "nope"}))
                .unwrap_err()
                .contains("invalid_union_discriminator")
        );
        assert!(
            args(json!({"action": "check"}))
                .unwrap_err()
                .contains("Required")
        );
        assert!(
            args(json!({"action": "open", "target": "  "}))
                .unwrap_err()
                .contains("at least 1 character")
        );
        assert!(args(json!({"action": "choose", "visual": "x", "timeout_seconds": 9})).is_err());
        assert!(args(json!({"action": "choose", "visual": "x", "timeout_seconds": 601})).is_err());
        assert!(args(json!({"action": "choose", "visual": "x", "timeout_seconds": 20.5})).is_err());
        assert!(args(json!("x")).is_err());
    }

    #[test]
    fn says_what_the_agent_reads() {
        let (d, mut store) = setup();
        let opened = open(&mut store, &d, &target("site/index.html")).unwrap();
        let id = opened.record.id.clone();
        let shown = open_text(&opened.record, opened.version, opened.added, None);
        assert!(!shown.is_error);
        assert_eq!(
            shown.text,
            format!(
                "Showing \"index.html\" in the user's Preview panel (visual {id}, version 1). The user may comment on it; their comments come as a message."
            )
        );
        assert!(
            open_text(&opened.record, 1, false, None)
                .text
                .contains("version 1 (unchanged))")
        );
        let hinted = open_text(&opened.record, 1, true, Some(Verdict::Blank)).text;
        assert!(hinted.ends_with("\nPreview check: the page looks blank (nothing rendered). Look at it with gui_visualize or fix the page."));
        assert_eq!(
            preview_hint(Verdict::Error),
            "Preview check: the page shows an error message. Look at it with gui_visualize or fix the page."
        );
        let web = open(&mut store, &d, &target("https://example.com/a")).unwrap();
        assert!(
            open_text(&web.record, 1, true, None)
                .text
                .contains(&format!("(visual {}). ", web.record.id))
        );

        let page = PageInfo {
            title: "One".into(),
            url: "omp-visual://x".into(),
            loading: false,
            problems: vec![Problem {
                level: "error".into(),
                message: "boom".into(),
                source: "app.js".into(),
                line: 3,
            }],
        };
        let check = check_text(Some(&page)).text;
        assert!(check.contains("Title: One") && check.contains("- error: boom (app.js:3)"));
        assert_eq!(
            check_text(Some(&PageInfo {
                title: String::new(),
                problems: vec![],
                loading: true,
                ..page
            }))
            .text,
            "Title: (none)\nAddress: omp-visual://x\nStill loading.\nNo console errors or warnings."
        );
        assert!(!check_text(None).is_error);
        assert_eq!(
            choose_text(&Choice::Picked {
                value: "b".into(),
                text: "Option B".into()
            })
            .text,
            "The user chose \"b\" (Option B)."
        );
        assert_eq!(
            choose_text(&Choice::Picked {
                value: "b".into(),
                text: String::new()
            })
            .text,
            "The user chose \"b\"."
        );
        assert!(choose_text(&Choice::None).is_error);
        assert!(
            choose_text(&Choice::Agent)
                .text
                .contains("choices count only from the user")
        );
        assert_eq!(
            choose_text(&Choice::Timeout),
            ToolText {
                text: "The user did not choose in time.".into(),
                is_error: false
            }
        );
        assert!(choose_text(&Choice::Closed).text.contains("closed before"));
        assert_eq!(
            not_in_tab_text("abc"),
            ToolText {
                text: "No visual abc in this tab".into(),
                is_error: true
            }
        );
        assert_eq!(
            close_text("abc"),
            ToolText {
                text: "Closed visual abc.".into(),
                is_error: false
            }
        );
        assert_eq!(choose_timeout_ms(None), 120_000);
        assert_eq!(choose_timeout_ms(Some(10)), 10_000);
        assert!(
            invalid_args_text("[]")
                .text
                .starts_with("Invalid gui_visualize arguments: ")
        );
    }

    #[test]
    fn sizes_the_picture_for_the_judge() {
        assert_eq!(judge_image_size(1280, 800), None);
        assert_eq!(judge_image_size(2560, 1440), Some((1280, 720)));
        assert_eq!(judge_image_size(1000, 5000), Some((256, 1280)));
        assert_eq!(judge_image_size(10_000, 3), Some((1280, 1)));
    }

    #[test]
    fn encodes_and_decodes_like_uri_components() {
        assert_eq!(encode_component("a b/ü.html"), "a%20b%2F%C3%BC.html");
        assert_eq!(decode_component("a%20b%C3%BC").as_deref(), Some("a bü"));
        assert_eq!(decode_component("%zz"), None);
        assert_eq!(decode_component("%FF"), None);
    }
}
