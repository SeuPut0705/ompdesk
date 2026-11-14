use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value, json};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipReadOptions, ZipWriter};

use crate::diagnostics::redactor::redact_diagnostics_file;
use crate::pool::application::Sidecar;
use crate::remote::events::js;
use crate::server::{Fault, Scope};

use super::protocol::{CommandError, CommandResult, RpcCommand};
use super::session::Session;

type Result<T, E = CommandError> = std::result::Result<T, E>;
pub const COMMANDS: &[&str] = &["dump_session_archive", "discard_session_archive"];

/// Process-wide ownership of redacted outputs, matching local/session-dump.ts's produced set. A page cannot
/// acquire deletion authority by naming a path, even when it is a paired device calling the execution host.
#[derive(Clone, Default)]
pub struct Archives {
    produced: Arc<Mutex<HashSet<PathBuf>>>,
}

impl Archives {
    pub async fn handle<S: Sidecar<Error = Fault> + ?Sized + 'static>(&self, command: &RpcCommand, session: &Session<S>) -> CommandResult {
        match command.kind.as_str() {
            "dump_session_archive" => {
                let anonymized = match command.params.get("anonymized") {
                    None => false,
                    Some(Value::Bool(value)) => *value,
                    Some(_) => return Err(CommandError::Other("Invalid anonymized value".into())),
                };
                let archive = session.bridge("session_dump", json!({"anonymized":anonymized})).await?;
                if !js::truthy(Some(&archive)) {
                    return Err(CommandError::local("no_messages", "No messages to dump yet."));
                }
                self.redact(archive, Scope::detached()).await.map(Some)
            }
            "discard_session_archive" => {
                let path = command.string("path").filter(|path| !path.is_empty())
                    .ok_or_else(|| CommandError::Other("Invalid archive path".into()))?;
                self.discard(Path::new(path)).map(|removed| Some(json!({"removed":removed})))
            }
            name => Err(CommandError::Other(format!("Unknown archive command: {name}"))),
        }
    }

    pub fn discard(&self, path: &Path) -> Result<bool> {
        let owned = self.produced.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(path);
        if !owned { return Ok(false); }
        remove(path)?;
        Ok(true)
    }

    /// Consumes a real bridge-produced stock archive. Dropping this future cancels its blocking ZIP work; the
    /// raw archive and an unpublished output remain owned by cleanup guards, including after a caller disconnect.
    pub async fn redact(&self, archive: Value, scope: Scope) -> Result<Value> {
        let path = archive.get("path").and_then(Value::as_str)
            .ok_or_else(|| CommandError::Other("Stock returned no session archive path".into()))?;
        let raw = RawArchive(PathBuf::from(path));
        let work_scope = Scope::detached();
        let cancel_on_drop = CancelOnDrop(work_scope.clone());
        let mut worker = tokio::task::spawn_blocking(move || consume(raw, archive, &work_scope, None));
        let pending = tokio::select! {
            biased;
            () = scope.on_cancel() => {
                cancel_on_drop.0.cancel();
                let _ = worker.await;
                return Err(Fault::cancelled().into());
            }
            result = &mut worker => result.map_err(|error| CommandError::Other(error.to_string()))??,
        };
        if scope.cancelled() { return Err(Fault::cancelled().into()); }
        Ok(pending.publish(&self.produced))
    }
}

struct CancelOnDrop(Scope);
impl Drop for CancelOnDrop {
    fn drop(&mut self) { self.0.cancel(); }
}

struct RawArchive(PathBuf);
impl RawArchive {
    fn remove(&self) -> Result<()> { remove(&self.0) }
}
impl Drop for RawArchive {
    fn drop(&mut self) { let _ = remove(&self.0); }
}

struct PendingArchive {
    path: PathBuf,
    response: Value,
    armed: bool,
}
impl PendingArchive {
    fn publish(mut self, produced: &Mutex<HashSet<PathBuf>>) -> Value {
        produced.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(self.path.clone());
        self.armed = false;
        std::mem::take(&mut self.response)
    }
}
impl Drop for PendingArchive {
    fn drop(&mut self) { if self.armed { let _ = remove(&self.path); } }
}

fn remove(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CommandError::Other(format!("{}: {error}", path.display()))),
    }
}
fn error(error: impl std::fmt::Display) -> CommandError { CommandError::Other(error.to_string()) }
fn live(scope: &Scope) -> io::Result<()> {
    if scope.cancelled() { Err(io::Error::other("Session archive cancelled")) } else { Ok(()) }
}
struct Checked<T> { inner: T, scope: Scope }
impl<T: Read> Read for Checked<T> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> { live(&self.scope)?; self.inner.read(out) }
}
impl<T: Write> Write for Checked<T> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> { live(&self.scope)?; self.inner.write(bytes) }
    fn flush(&mut self) -> io::Result<()> { live(&self.scope)?; self.inner.flush() }
}
impl<T: Seek> Seek for Checked<T> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> { live(&self.scope)?; self.inner.seek(position) }
}

fn consume(raw: RawArchive, original: Value, scope: &Scope, output: Option<PathBuf>) -> Result<PendingArchive> {
    let result = redact_owned(&raw.0, original, scope, output);
    // Close every reader before deleting stock's zip (Windows), and propagate cleanup failures as errors.
    raw.remove()?;
    result
}

fn redact_owned(raw: &Path, original: Value, scope: &Scope, output: Option<PathBuf>) -> Result<PendingArchive> {
    if scope.cancelled() { return Err(Fault::cancelled().into()); }
    let input = File::open(raw).map_err(error)?;
    let mut source = ZipArchive::new(Checked { inner: input, scope: scope.clone() }).map_err(error)?;
    let mut members = Map::new();
    for index in 0..source.len() {
        let entry = source.by_index_with_options(index, ZipReadOptions::new().ignore_crc32(true)).map_err(error)?;
        // JSZip's default filename decoder is UTF-8 with replacement, including legacy names without the flag.
        let name = member_name(&String::from_utf8_lossy(entry.name_raw()));
        js::set(&mut members, name, json!({"index":index,"dir":entry.is_dir()}));
    }
    let path = output.unwrap_or_else(|| raw.with_file_name(format!("ompdesk-dump-{}.zip", crate::web::uploads::uuid())));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&path).map_err(error)?;
    let mut pending = PendingArchive { path, response: Value::Null, armed: true };
    let mut writer = ZipWriter::new(Checked { inner: file, scope: scope.clone() });
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).compression_level(Some(6));
    let mut files = Vec::new();
    let mut dropped = Vec::new();
    for (name, member) in members {
        if member["dir"] == true { continue; }
        if scope.cancelled() { return Err(Fault::cancelled().into()); }
        let index = member["index"].as_u64().expect("native ZIP member index") as usize;
        let entry = source.by_index_with_options(index, ZipReadOptions::new().ignore_crc32(true)).map_err(error)?;
        let mut bytes = Vec::new();
        let mut reader = Checked { inner: entry, scope: scope.clone() };
        let text = reader.read_to_end(&mut bytes).ok().and_then(|_| String::from_utf8(bytes).ok()).filter(|text| !text.contains('\0'));
        if scope.cancelled() { return Err(Fault::cancelled().into()); }
        let Some(text) = text else { dropped.push(name); continue; };
        let redacted = redact_diagnostics_file(&name, &text);
        writer.start_file(&name, options).map_err(error)?;
        writer.write_all(redacted.as_bytes()).map_err(error)?;
        files.push(name);
    }
    writer.finish().map_err(error)?;
    if scope.cancelled() { return Err(Fault::cancelled().into()); }
    let mut response = json!({"path":pending.path,"files":files,"redacted":true});
    for key in ["subagentCount", "anonymized"] {
        if let Some(value) = original.get(key) { response[key] = value.clone(); }
    }
    if let Some(value) = original.get("subagentError").filter(|value| js::truthy(Some(value))) { response["subagentError"] = value.clone(); }
    if !dropped.is_empty() { response["dropped"] = json!(dropped); }
    pending.response = response;
    Ok(pending)
}

/// JSZip's utils.resolve: normalize member names without ever extracting them into the filesystem. Last duplicate
/// wins, first property position remains, and JS array-index keys sort first through the existing js::set helper.
fn member_name(path: &str) -> String {
    let parts: Vec<_> = path.split('/').collect();
    let mut out = Vec::with_capacity(parts.len());
    for (index, part) in parts.iter().enumerate() {
        if *part == "." || (part.is_empty() && index != 0 && index != parts.len() - 1) { continue; }
        if *part == ".." { out.pop(); } else { out.push(*part); }
    }
    out.join("/")
}

#[cfg(test)]
#[path = "archive_tests.rs"]
mod tests;
