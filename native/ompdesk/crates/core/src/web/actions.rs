//! Web-only actions from `host-actions.ts`. Caller and workspace authority are injected as native
//! handles; the page supplies only an action's arguments. Files use the existing core disk/order
//! rules, shell opens use the canonical safe Services implementation, model text uses its one
//! stamped/validated model configuration service.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine as _;
use base64::alphabet::STANDARD;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use ompdesk_app_contract::Owner;
use serde::Serialize;
use serde_json::{Value, json};

use super::blobs::{BlobStore, NewBlob, Source};
use super::deps::{BoxFuture, Clock};
use super::native::Invocation;
use super::router::Host as Router;
use super::store::FileDevices;
use super::uploads::UploadStore;
use crate::fs::disk::{self, Kind};
use crate::fs::error::{Codes, NodeError};
use crate::fs::order::{NameOrder, js_trim};
use crate::server::Fault;

pub const DEVICE_UI_PREFS_MAX_UNITS: usize = 64 * 1024;
const LIST_MAX: usize = 500;
const BINARY_MAX: u64 = 100 * 1024 * 1024;
const DECODE: GeneralPurpose = GeneralPurpose::new(
    &STANDARD,
    GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// The same native path/MIME service the desktop FS channels use. The implementation resolves
/// cwd/remote/home from Owner and trusted tab state; it must never read them out of request args.
pub trait Paths: Send + Sync {
    fn home(&self) -> &Path;
    fn locale(&self) -> &str;
    fn absolute(&self, raw: &str) -> Result<PathBuf, Fault>;
    fn workspace(&self, owner: &Owner, tab: Option<&str>, raw: &str) -> Result<PathBuf, Fault>;
    fn mime(&self, header: &[u8], path: &Path) -> String;
}

/// These methods are the existing safe Services routes, not raw OS launch primitives. `open_path`
/// reveals launcher/executable/symlink targets; `open_external` permits only http(s)/mail drafts.
pub trait Shell: Send + Sync {
    fn open_path<'a>(
        &'a self,
        owner: &'a Owner,
        path: &'a Path,
    ) -> BoxFuture<'a, Result<(), Fault>>;
    fn reveal(&self, owner: &Owner, path: &Path) -> Result<(), Fault>;
    fn open_external<'a>(
        &'a self,
        owner: &'a Owner,
        url: &'a str,
    ) -> BoxFuture<'a, Result<(), Fault>>;
}

#[derive(Serialize)]
pub struct ModelsText {
    pub path: String,
    pub text: String,
    pub exists: bool,
    pub stamp: String,
}

/// The one models.yml service: full editor text is allowed only after settings-write admission.
/// Writes reuse stock's normalization/schema, preserve secrets/comments, compare the opened stamp
/// and atomically replace the real target with its existing mode (new files 0600).
pub trait Models: Send + Sync {
    fn read(&self) -> BoxFuture<'_, Result<ModelsText, Fault>>;
    fn write<'a>(&'a self, text: &'a str, stamp: &'a str) -> BoxFuture<'a, Result<String, Fault>>;
}

pub struct Actions {
    pub router: Arc<Router>,
    pub devices: Arc<FileDevices>,
    pub uploads: Arc<UploadStore>,
    pub blobs: Arc<BlobStore>,
    pub paths: Arc<dyn Paths>,
    pub shell: Arc<dyn Shell>,
    pub models: Arc<dyn Models>,
    pub clock: Clock,
}

impl Actions {
    /// `None` means this is not a web-only channel; Base then invokes the common native handler.
    pub async fn handle(
        &self,
        owner: &Owner,
        call: &Invocation,
        args: &[Value],
    ) -> Result<Option<Value>, Fault> {
        if !self.router.authenticates(call) {
            return Err(Fault::new(
                "web_forbidden",
                "This device is no longer paired",
            ));
        }
        let device = call.device();
        let given = args.first();
        let result = match call.channel() {
            "web:device.uiPrefs.get" => self.devices.get(device).ok_or_else(forbidden)?.ui_prefs,
            "web:device.uiPrefs.set" => {
                let prefs = given.filter(|v| v.is_object()).ok_or_else(invalid)?;
                if serde_json::to_string(prefs)
                    .map_err(|_| invalid())?
                    .encode_utf16()
                    .count()
                    > DEVICE_UI_PREFS_MAX_UNITS
                {
                    return Err(Fault::new("invalid_content", "Preferences are too large"));
                }
                self.devices
                    .apply(None, |book| book.set_ui_prefs(device, prefs.clone()))
                    .into()
            }
            "web:host.listDirs" => {
                let empty = json!({});
                let request = object(given.unwrap_or(&empty))?;
                let raw = optional_string(request, "path", 4096)?.filter(|s| !s.is_empty());
                let path = self.paths.absolute(
                    raw.unwrap_or_else(|| self.paths.home().to_str().unwrap_or_default()),
                )?;
                let query = optional_string(request, "query", 255)?
                    .unwrap_or_default()
                    .to_owned();
                let files = optional_bool(request, "files")?.unwrap_or(false);
                let home = self.paths.home().to_path_buf();
                let locale = self.paths.locale().to_owned();
                tokio::task::spawn_blocking(move || list_dirs(&path, &home, &query, files, &locale))
                    .await
                    .map_err(join_error)??
            }
            "web:host.save" => {
                let request = object(given.ok_or_else(invalid)?)?;
                let dir = required_string(request, "dir", 1, 4096)?;
                let name = required_string(request, "name", 1, 255)?;
                let data = optional_string(request, "data", 1_000_000)?;
                let upload = optional_string(request, "uploadPath", 4096)?;
                let overwrite = optional_bool(request, "overwrite")?.unwrap_or(false);
                if !valid_name(name) {
                    return Ok(Some(failure("invalid_name", "Invalid file name")));
                }
                if data.is_some() == upload.is_some() {
                    return Ok(Some(failure(
                        "invalid_content",
                        "Give either data or uploadPath",
                    )));
                }
                let dir = match self.paths.absolute(dir) {
                    Ok(path) => path,
                    Err(error) => return Ok(Some(failure(&error.code, &error.message))),
                };
                if !std::fs::metadata(&dir).is_ok_and(|m| m.is_dir()) {
                    return Ok(Some(failure("not_a_directory", "Not a folder")));
                }
                let target = dir.join(name);
                let source = if let Some(upload) = upload {
                    if !self.uploads.owns(device, upload) {
                        return Ok(Some(failure(
                            "path_escapes_roots",
                            "Not one of this device's uploads",
                        )));
                    }
                    Save::Upload(PathBuf::from(upload))
                } else {
                    Save::Bytes(decode_base64(data.unwrap_or_default()))
                };
                tokio::task::spawn_blocking(move || save(&target, source, overwrite))
                    .await
                    .map_err(join_error)?
            }
            "web:host.open" | "web:host.reveal" => {
                let request = object(given.ok_or_else(invalid)?)?;
                let raw = required_string(request, "path", 1, 4096)?;
                let path = match self.paths.absolute(raw) {
                    Ok(path) => path,
                    Err(error) => return Ok(Some(json!({"ok":false,"error":error.message}))),
                };
                if std::fs::metadata(&path).is_err() {
                    return Ok(Some(json!({"ok":false,"error":"File not found"})));
                }
                if call.channel() == "web:host.open" {
                    self.shell.open_path(owner, &path).await?;
                } else {
                    self.shell.reveal(owner, &path)?;
                }
                json!({"ok":true})
            }
            "web:host.openExternal" => {
                let request = object(given.ok_or_else(invalid)?)?;
                let url = required_string(request, "url", 1, 8192)?;
                if is_openable_external_url(url) {
                    self.shell.open_external(owner, url).await?;
                }
                Value::Null
            }
            "web:blob.open" => {
                let request = object(given.ok_or_else(invalid)?)?;
                let raw = required_string(request, "path", 1, 4096)?;
                let tab = optional_string(request, "tabId", 128)?;
                let download = optional_bool(request, "download")?.unwrap_or(false);
                let path = match self.paths.workspace(owner, tab, raw) {
                    Ok(path) => path,
                    Err(error) => return Ok(Some(failure(&error.code, &error.message))),
                };
                let file = tokio::task::spawn_blocking(move || blob_file(&path))
                    .await
                    .map_err(join_error)?;
                let (path, header, size) = match file {
                    Ok(file) => file,
                    Err(error) => return Ok(Some(failure(&error.code, &error.message))),
                };
                let mime = self.paths.mime(&header, &path);
                let name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                let token = super::blobs::mint_token()?;
                self.blobs.add(
                    (self.clock)(),
                    &token,
                    NewBlob {
                        device,
                        source: Source::File(path),
                        mime: &mime,
                        name: &name,
                        download,
                    },
                );
                json!({"ok":true,"url":format!("/blob/{token}"),"mime":mime,"size":size,"name":name})
            }
            "web:blob.release" => {
                let given = given.ok_or_else(invalid)?;
                let url = match given {
                    Value::String(url) if units(url, 1, 512) => url.as_str(),
                    Value::Object(map) => required_string(map, "url", 1, 512)?,
                    _ => return Err(invalid()),
                };
                self.blobs.release(device, url);
                Value::Null
            }
            "web:models.config.read" => serde_json::to_value(self.models.read().await?)
                .map_err(|e| Fault::new("internal", e.to_string()))?,
            "web:models.config.write" => {
                let request = object(given.ok_or_else(invalid)?)?;
                let text = required_string(request, "text", 0, 512 * 1024)?;
                let stamp = required_string(request, "stamp", 1, 256)?;
                match self.models.write(text, stamp).await {
                    Ok(stamp) => json!({"ok":true,"stamp":stamp}),
                    Err(error) => failure("invalid_content", strip_code(&error.message)),
                }
            }
            _ => return Ok(None),
        };
        Ok(Some(result))
    }
}

/// The `external-url.ts` admission rule for native adapters.
pub fn is_openable_external_url(url: &str) -> bool {
    url.starts_with("https://")
        || url.starts_with("http://")
        || (url
            .get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("mailto:"))
            && url.len() > 7
            && !url[7..]
                .chars()
                .any(|c| super::auth::js_space(c) || c.is_control()))
}

fn invalid() -> Fault {
    Fault::new("invalid_content", "Invalid request")
}
fn forbidden() -> Fault {
    Fault::new("web_forbidden", "This device is no longer paired")
}
fn join_error(error: tokio::task::JoinError) -> Fault {
    Fault::new("internal", error.to_string())
}
fn failure(code: &str, message: &str) -> Value {
    json!({"ok":false,"error":message,"code":code})
}
fn object(value: &Value) -> Result<&serde_json::Map<String, Value>, Fault> {
    value.as_object().ok_or_else(invalid)
}
fn units(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.encode_utf16().count())
}
fn required_string<'a>(
    map: &'a serde_json::Map<String, Value>,
    key: &str,
    min: usize,
    max: usize,
) -> Result<&'a str, Fault> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|s| units(s, min, max))
        .ok_or_else(invalid)
}
fn optional_string<'a>(
    map: &'a serde_json::Map<String, Value>,
    key: &str,
    max: usize,
) -> Result<Option<&'a str>, Fault> {
    map.get(key)
        .map(|v| v.as_str().filter(|s| units(s, 0, max)).ok_or_else(invalid))
        .transpose()
}
fn optional_bool(map: &serde_json::Map<String, Value>, key: &str) -> Result<Option<bool>, Fault> {
    map.get(key)
        .map(|v| v.as_bool().ok_or_else(invalid))
        .transpose()
}
fn valid_name(name: &str) -> bool {
    js_trim(name) == name
        && !matches!(name, "." | "..")
        && !name
            .chars()
            .any(|c| matches!(c, '/' | '\\') || c.is_control())
}
fn strip_code(message: &str) -> &str {
    if let Some(rest) = message.strip_prefix('[')
        && let Some((code, tail)) = rest.split_once(']')
        && !code.is_empty()
        && code.chars().all(|c| c.is_ascii_lowercase() || c == '_')
    {
        return tail.trim_start_matches(super::auth::js_space);
    }
    message
}

#[derive(Serialize)]
struct Entry {
    name: String,
    path: PathBuf,
    directory: bool,
    size: Option<u64>,
}
fn list_dirs(
    path: &Path,
    home: &Path,
    query: &str,
    files: bool,
    locale: &str,
) -> Result<Value, Fault> {
    let order = NameOrder::new(locale);
    let needle = order.lowercase(js_trim(query));
    let entries = disk::read_dir(&path.to_string_lossy()).map_err(|e| match e.code {
        "ENOTDIR" => Fault::new("not_a_directory", "Not a directory"),
        "ENOENT" => Fault::new("file_not_found", "Directory not found"),
        _ => e.fault(Codes::None),
    })?;
    let mut found = Vec::new();
    for entry in entries {
        if entry.name.starts_with('.')
            || (!needle.is_empty() && !order.lowercase(&entry.name).contains(&needle))
        {
            continue;
        }
        let full = path.join(entry.raw);
        let mut directory = entry.kind == Kind::Dir;
        let mut size = None;
        if matches!(entry.kind, Kind::File | Kind::Link) {
            let Ok(info) = std::fs::metadata(&full) else {
                continue;
            };
            directory = info.is_dir();
            if !directory {
                size = Some(info.len());
            }
        }
        if !directory && (!files || !matches!(entry.kind, Kind::File | Kind::Link)) {
            continue;
        }
        found.push(Entry {
            name: entry.name,
            path: full,
            directory,
            size,
        });
    }
    found.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| order.compare(&a.name, &b.name))
    });
    let truncated = found.len() > LIST_MAX;
    found.truncate(LIST_MAX);
    let parent = path.parent().filter(|p| *p != path);
    Ok(json!({"path":path,"parent":parent,"home":home,"entries":found,"truncated":truncated}))
}

enum Save {
    Upload(PathBuf),
    Bytes(Vec<u8>),
}
fn save(target: &Path, source: Save, overwrite: bool) -> Value {
    let write = || -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true);
        if overwrite {
            options.create(true).truncate(true);
        } else {
            options.create_new(true);
        }
        match &source {
            Save::Upload(path) => {
                let mut input = std::fs::File::open(path)?;
                let permissions = input.metadata()?.permissions();
                let mut output = options.open(target)?;
                if let Err(error) = std::io::copy(&mut input, &mut output) {
                    let _ = std::fs::remove_file(target);
                    return Err(error);
                }
                std::fs::set_permissions(target, permissions)?;
            }
            Save::Bytes(bytes) => options.open(target)?.write_all(bytes)?,
        }
        Ok(())
    };
    match write() {
        Ok(()) => json!({"ok":true,"path":target}),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            failure("exists", "A file with that name exists")
        }
        Err(error) => {
            json!({"ok":false,"error":NodeError::new(&error,"open",Some(&target.to_string_lossy())).message})
        }
    }
}

fn decode_base64(text: &str) -> Vec<u8> {
    // Buffer.from(base64) ignores whitespace/non-alphabet characters, accepts the URL-safe
    // alphabet and stops at the first padding. Keep that editor/save contract at this boundary.
    let mut cleaned: Vec<u8> = text
        .bytes()
        .take_while(|b| *b != b'=')
        .filter_map(|b| match b {
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            b if b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/') => Some(b),
            _ => None,
        })
        .collect();
    if cleaned.len() % 4 == 1 {
        cleaned.pop();
    }
    DECODE.decode(cleaned).unwrap_or_default()
}

fn blob_file(path: &Path) -> Result<(PathBuf, Vec<u8>, u64), Fault> {
    let info = std::fs::metadata(path)
        .ok()
        .filter(|m| m.is_file())
        .ok_or_else(|| Fault::new("file_not_found", "File not found"))?;
    if info.len() > BINARY_MAX {
        return Err(Fault::new("file_too_large", "File too large"));
    }
    let mut header = vec![0; info.len().min(512) as usize];
    let mut file = disk::open(&path.to_string_lossy()).map_err(|e| e.fault(Codes::None))?;
    let read = file
        .read(&mut header)
        .map_err(|e| Fault::new("io", e.to_string()))?;
    header.truncate(read);
    Ok((path.into(), header, info.len()))
}

#[cfg(test)]
#[path = "actions_tests.rs"]
mod tests;
