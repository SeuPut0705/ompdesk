//! Canonical native path admission and MIME rules from workspace-fs.ts and web/host-actions.ts.
//! Context comes from the authenticated pool, not page JSON. Confinement is lexical, as in the
//! original resolveWithin; disk reads and mutation-specific realpath guards remain in core/fs.

use crate::server::Fault;
use ompdesk_app_contract::Owner;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

pub struct PathContext {
    pub cwd: Option<PathBuf>,
    pub remote: bool,
}
pub trait Workspaces: Send + Sync {
    fn context(&self, owner: &Owner, tab: Option<&str>) -> Result<PathContext, Fault>;
}
pub struct Service {
    home: PathBuf,
    locale: String,
    workspaces: Arc<dyn Workspaces>,
}
impl Service {
    pub fn new(home: PathBuf, locale: String, workspaces: Arc<dyn Workspaces>) -> Self {
        Self {
            home,
            locale,
            workspaces,
        }
    }
    pub fn read(&self, owner: &Owner, tab: Option<&str>, raw: &str) -> Result<PathBuf, Fault> {
        let expanded = expand_home(raw, &self.home, false);
        if expanded.is_absolute() {
            return Ok(resolve(&expanded));
        }
        let context = self.workspaces.context(owner, tab)?;
        read_path(
            if context.remote {
                None
            } else {
                context.cwd.as_deref()
            },
            &self.home,
            raw,
        )
    }
}
impl super::actions::Paths for Service {
    fn home(&self) -> &Path {
        &self.home
    }
    fn locale(&self) -> &str {
        &self.locale
    }
    fn absolute(&self, raw: &str) -> Result<PathBuf, Fault> {
        absolute(raw, &self.home)
    }
    fn workspace(&self, owner: &Owner, tab: Option<&str>, raw: &str) -> Result<PathBuf, Fault> {
        let expanded = expand_home(raw, &self.home, true);
        if expanded.is_absolute() {
            return Ok(resolve(&expanded));
        }
        let context = self.workspaces.context(owner, tab)?;
        let cwd = context
            .cwd
            .as_deref()
            .filter(|_| !context.remote)
            .ok_or_else(no_workspace)?;
        resolve_within(cwd, &expanded).ok_or_else(escapes)
    }
    fn mime(&self, header: &[u8], path: &Path) -> String {
        sniff_mime(header, path).to_owned()
    }
}
fn no_workspace() -> Fault {
    Fault::new("no_workspace", "No workspace")
}
fn escapes() -> Fault {
    Fault::new("path_escapes_workspace", "Path escapes the workspace")
}

fn expand_home(raw: &str, home: &Path, bare: bool) -> PathBuf {
    if bare && raw == "~" {
        return home.to_path_buf();
    }
    if let Some(tail) = raw.strip_prefix("~/") {
        // Node path.join does not let a second slash in the tail replace home.
        let mut path = home.as_os_str().to_owned();
        path.push(std::path::MAIN_SEPARATOR_STR);
        path.push(tail);
        return resolve(Path::new(&path));
    }
    raw.into()
}
pub fn absolute(raw: &str, home: &Path) -> Result<PathBuf, Fault> {
    let path = expand_home(raw, home, true);
    if !path.is_absolute() {
        return Err(Fault::new("not_absolute_path", "Not an absolute path"));
    }
    Ok(resolve(&path))
}
pub fn read_path(cwd: Option<&Path>, home: &Path, raw: &str) -> Result<PathBuf, Fault> {
    let path = expand_home(raw, home, false);
    if path.is_absolute() {
        return Ok(resolve(&path));
    }
    resolve_within(cwd.ok_or_else(no_workspace)?, &path).ok_or_else(escapes)
}
pub fn resolve_within(root: &Path, target: &Path) -> Option<PathBuf> {
    let path = resolve_from(root, target);
    // Node's string-prefix comparison is case sensitive even on Windows.
    let root = root.to_string_lossy();
    let path_text = path.to_string_lossy();
    let mut prefix = root.to_string();
    if !prefix.ends_with(std::path::MAIN_SEPARATOR) {
        prefix.push(std::path::MAIN_SEPARATOR);
    }
    (path_text == root || path_text.starts_with(&prefix)).then_some(path)
}
fn resolve_from(root: &Path, target: &Path) -> PathBuf {
    #[cfg(windows)]
    let target = {
        let mut parts = target.components();
        if let Some(Component::Prefix(prefix)) = parts.next() {
            if !target.has_root() && root.components().next() == Some(Component::Prefix(prefix)) {
                return normalize(&root.join(parts.as_path()));
            }
        }
        target
    };
    normalize(&root.join(target))
}
pub(crate) fn resolve(path: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize(path)
    } else {
        resolve_from(&std::env::current_dir().unwrap_or_default(), path)
    }
}
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => out.push(component),
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

fn ascii(header: &[u8], at: usize, text: &[u8]) -> bool {
    header.get(at..at.saturating_add(text.len())) == Some(text)
}
fn magic(header: &[u8]) -> Option<&'static str> {
    if ascii(header, 0, b"%PDF-") {
        return Some("application/pdf");
    }
    if ascii(header, 0, b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if ascii(header, 0, b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if ascii(header, 0, b"GIF87a") || ascii(header, 0, b"GIF89a") {
        return Some("image/gif");
    }
    if ascii(header, 0, b"RIFF") {
        if ascii(header, 8, b"WEBP") {
            return Some("image/webp");
        }
        if ascii(header, 8, b"WAVE") {
            return Some("audio/wav");
        }
    }
    if header.len() >= 12 && ascii(header, 4, b"ftyp") {
        return Some(match &header[8..12] {
            b"avif" | b"avis" => "image/avif",
            b"qt  " => "video/quicktime",
            b"M4A " | b"M4B " => "audio/mp4",
            _ => "video/mp4",
        });
    }
    if ascii(header, 0, b"\x1aE\xdf\xa3") {
        return Some(
            if header[..header.len().min(64)]
                .windows(4)
                .any(|s| s == b"webm")
            {
                "video/webm"
            } else {
                "video/x-matroska"
            },
        );
    }
    if ascii(header, 0, b"ID3") {
        return Some("audio/mpeg");
    }
    if ascii(header, 0, b"OggS") {
        return Some("audio/ogg");
    }
    if ascii(header, 0, b"fLaC") {
        return Some("audio/flac");
    }
    if ascii(header, 0, b"PK")
        && [b"\x03\x04", b"\x05\x06", b"\x07\x08"]
            .iter()
            .any(|s| ascii(header, 2, *s))
    {
        return Some("application/zip");
    }
    if ascii(header, 0, b"\x1f\x8b") {
        return Some("application/gzip");
    }
    if ascii(header, 0, b"SQLite format 3\0") {
        return Some("application/vnd.sqlite3");
    }
    if ascii(header, 0, b"BM") && ascii(header, 6, b"\0\0\0\0") {
        return Some("image/bmp");
    }
    if ascii(header, 0, b"\0\0\x01\0") && header.len() >= 6 && (header[4] != 0 || header[5] != 0) {
        return Some("image/x-icon");
    }
    let second = header.get(1).copied().unwrap_or_default();
    if header.first() == Some(&255)
        && second & 0xe0 == 0xe0
        && second & 0x18 != 0x08
        && second & 0x06 != 0
    {
        return Some("audio/mpeg");
    }
    None
}
const DOCX: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX: &str = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
fn extension(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_str()?;
    let dot = name.rfind('.')?;
    if dot == 0 || name == ".." {
        return None;
    }
    let suffix = &name.as_bytes()[dot + 1..];
    // The longest recognized suffix is "sqlite3"; no longer suffix can match this table.
    let mut folded = [0u8; 7];
    if suffix.len() > folded.len() {
        return None;
    }
    for (out, byte) in folded.iter_mut().zip(suffix) {
        *out = byte.to_ascii_lowercase();
    }
    Some(match std::str::from_utf8(&folded[..suffix.len()]).ok()? {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "weba" => "audio/webm",
        "flac" => "audio/flac",
        "docx" => DOCX,
        "xlsx" => XLSX,
        "pptx" => PPTX,
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "tar" => "application/x-tar",
        "7z" => "application/x-7z-compressed",
        "sqlite" | "sqlite3" => "application/vnd.sqlite3",
        "wasm" => "application/wasm",
        _ => return None,
    })
}
pub fn sniff_mime(header: &[u8], path: &Path) -> &'static str {
    let by_extension = extension(path);
    if let Some(magic) = magic(header) {
        let refined = matches!(
            (magic, by_extension),
            ("application/zip", Some(DOCX | XLSX | PPTX))
                | ("video/mp4", Some("audio/mp4"))
                | ("audio/ogg", Some("video/ogg"))
                | ("video/webm", Some("audio/webm"))
        );
        if refined {
            return by_extension.unwrap();
        }
        return magic;
    }
    by_extension.unwrap_or("application/octet-stream")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relative_reads_refuse_escapes_and_absolute_reads_need_no_workspace() {
        let root = std::env::current_dir().unwrap().join("workspace");
        let home = std::env::current_dir().unwrap().join("home");
        assert_eq!(
            read_path(Some(&root), &home, "src/../file").unwrap(),
            root.join("file")
        );
        assert_eq!(
            read_path(Some(&root), &home, "../workspace-other/file")
                .unwrap_err()
                .code,
            "path_escapes_workspace"
        );
        assert_eq!(
            read_path(None, &home, "file").unwrap_err().code,
            "no_workspace"
        );
        assert_eq!(read_path(None, &home, "~/file").unwrap(), home.join("file"));
        assert_eq!(absolute("~", &home).unwrap(), home);
        assert!(absolute("relative", &home).is_err());
        assert_eq!(
            resolve_within(root.parent().unwrap(), Path::new(".")),
            Some(root.parent().unwrap().into())
        );
    }
    #[cfg(windows)]
    #[test]
    fn windows_drive_relative_rooted_and_unc_paths_keep_node_confinement() {
        let root = Path::new(r"C:\workspace");
        assert_eq!(
            resolve_within(root, Path::new(r"C:child")),
            Some(PathBuf::from(r"C:\workspace\child"))
        );
        assert_eq!(
            resolve_within(root, Path::new(r"\workspace\child")),
            Some(PathBuf::from(r"C:\workspace\child"))
        );
        assert!(resolve_within(root, Path::new(r"D:child")).is_none());
        assert!(resolve_within(root, Path::new(r"\outside")).is_none());
        assert!(
            resolve_within(Path::new(r"\\host\share\workspace"), Path::new(r"..\other")).is_none()
        );
    }

    #[test]
    fn magic_wins_except_the_original_container_refinements() {
        assert_eq!(
            sniff_mime(b"%PDF-1.7", Path::new("photo.png")),
            "application/pdf"
        );
        assert_eq!(sniff_mime(b"PK\x03\x04", Path::new("report.DOCX")), DOCX);
        assert_eq!(sniff_mime(b"OggS", Path::new("movie.ogv")), "video/ogg");
        assert_eq!(
            sniff_mime(b"<svg>", Path::new("unknown")),
            "application/octet-stream"
        );
        assert_eq!(
            sniff_mime(b"<svg>", Path::new("image.svg")),
            "image/svg+xml"
        );
        assert_eq!(
            sniff_mime(b"\0\0\0\x18ftypisom", Path::new("audio.m4a")),
            "audio/mp4"
        );
        assert_eq!(
            sniff_mime(b"\x1aE\xdf\xa3\0webm", Path::new("audio.weba")),
            "audio/webm"
        );
        assert_eq!(
            sniff_mime(b"BMgarbage", Path::new("unknown")),
            "application/octet-stream"
        );
    }
}
