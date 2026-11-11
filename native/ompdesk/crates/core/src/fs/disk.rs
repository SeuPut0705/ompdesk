//! The file system calls, each failing as node's would (code and message), on paths main resolved.

use std::fs::{self, File, Metadata};
use std::hash::{BuildHasher, RandomState};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::error::NodeError;

/// A path main resolved; node refuses one with a NUL before calling the system.
fn arg(path: &str) -> Result<&Path, NodeError> {
    if path.contains('\0') {
        return Err(NodeError::nul_in_path("path", path));
    }
    Ok(Path::new(path))
}

/// `fsp.stat`: follows links.
pub fn stat(path: &str) -> Result<Metadata, NodeError> {
    fs::metadata(arg(path)?).map_err(|error| NodeError::new(&error, "stat", Some(path)))
}

/// `fsp.lstat`: the entry itself.
pub fn lstat(path: &str) -> Result<Metadata, NodeError> {
    fs::symlink_metadata(arg(path)?).map_err(|error| NodeError::new(&error, "lstat", Some(path)))
}

/// `fsp.open(path, "r")`.
pub fn open(path: &str) -> Result<File, NodeError> {
    File::open(arg(path)?).map_err(|error| NodeError::new(&error, "open", Some(path)))
}

/// `fsp.realpath`.
pub fn realpath(path: &str) -> Result<std::path::PathBuf, NodeError> {
    fs::canonicalize(arg(path)?).map_err(|error| NodeError::new(&error, "realpath", Some(path)))
}

/// A canonical path as node's `realpath` spells it (libuv drops Windows' `\\?\` prefix).
pub fn spelled(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
}

/// Fills `buffer` from the file's current position; fewer bytes only at the end of the file.
pub fn read_into(file: &mut File, buffer: &mut [u8]) -> Result<usize, NodeError> {
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(NodeError::new(&error, "read", None)),
        }
    }
    Ok(filled)
}

/// `stat.mtimeMs` as node computes it (`sec * 1e3 + nsec / 1e6` in doubles), so the number equals main's.
pub fn mtime_ms(meta: &Metadata) -> f64 {
    let Ok(modified) = meta.modified() else {
        return 0.0;
    };
    let (sec, nsec) = match modified.duration_since(UNIX_EPOCH) {
        Ok(since) => (since.as_secs() as f64, f64::from(since.subsec_nanos())),
        Err(before) => {
            let before = before.duration();
            let nanos = before.subsec_nanos();
            if nanos == 0 {
                (-(before.as_secs() as f64), 0.0)
            } else {
                (
                    -(before.as_secs() as f64) - 1.0,
                    f64::from(1_000_000_000 - nanos),
                )
            }
        }
    };
    sec * 1000.0 + nsec / 1_000_000.0
}

/// What a directory entry is, as node's `Dirent` says without following links. On Windows any reparse point is a
/// link, as libuv reports it (a OneDrive placeholder too).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Link,
    /// A socket, a FIFO, a device: never listed. Windows reports none (libuv calls every such entry a file).
    #[cfg(not(windows))]
    Other,
}

/// One entry of a folder: its name as node gives it (UTF-8, lossy) and the name to open it by.
pub struct Entry {
    pub name: String,
    pub raw: std::ffi::OsString,
    pub kind: Kind,
}

/// `fsp.readdir(path, { withFileTypes: true })`: every entry or the error, as node reads the folder whole.
pub fn read_dir(path: &str) -> Result<Vec<Entry>, NodeError> {
    entries(arg(path)?).map_err(|error| NodeError::new(&error, "scandir", Some(path)))
}

/// A folder's entries by any path (the walk joins entry names as the system gave them), in node's order: libuv's
/// `scandir` sorts them by their bytes on POSIX (which decides between names a collation ranks equal, `1` and `01`),
/// and keeps the system's order on Windows.
pub fn entries(path: &Path) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let kind = kind(&entry)?;
        let raw = entry.file_name();
        entries.push(Entry {
            name: raw.to_string_lossy().into_owned(),
            raw,
            kind,
        });
    }
    #[cfg(not(windows))]
    entries.sort_by(|a, b| a.raw.as_encoded_bytes().cmp(b.raw.as_encoded_bytes()));
    Ok(entries)
}

#[cfg(not(windows))]
fn kind(entry: &fs::DirEntry) -> io::Result<Kind> {
    let file_type = entry.file_type()?;
    Ok(if file_type.is_symlink() {
        Kind::Link
    } else if file_type.is_dir() {
        Kind::Dir
    } else if file_type.is_file() {
        Kind::File
    } else {
        Kind::Other
    })
}

#[cfg(windows)]
fn kind(entry: &fs::DirEntry) -> io::Result<Kind> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    // A directory entry's metadata on Windows comes from the listing itself: no extra call, no link followed.
    let attributes = entry.metadata()?.file_attributes();
    Ok(if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        Kind::Link
    } else if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        Kind::Dir
    } else {
        Kind::File
    })
}

/// Whether two entries are one (`lstat` device and inode), which a case-only rename on a case-insensitive disk
/// finds.
#[cfg(unix)]
pub fn same_entry(a: &Metadata, b: &Metadata, _a_path: &str, _b_path: &str) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.ino() == b.ino() && a.dev() == b.dev()
}

/// Windows keeps a file's index unstable in std; `same-file` opens both (following links), so two entries where one
/// is a link are never the same, as `lstat` would have said.
#[cfg(windows)]
pub fn same_entry(a: &Metadata, b: &Metadata, a_path: &str, b_path: &str) -> bool {
    if a.file_type().is_symlink() || b.file_type().is_symlink() {
        return false;
    }
    same_file::is_same_file(a_path, b_path).unwrap_or(false)
}

/// A fresh folder `<temp>/<prefix>XXXXXX`, only the user's (node's `fs.mkdtemp` in `os.tmpdir()`).
pub fn make_temp_dir(prefix: &str) -> Result<PathBuf, NodeError> {
    const LETTERS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let base = std::env::temp_dir();
    let random = RandomState::new();
    let mut attempt = 0u32;
    loop {
        let mut bits = random.hash_one(attempt);
        let name: String = (0..6)
            .map(|_| {
                let letter = LETTERS[(bits % LETTERS.len() as u64) as usize];
                bits /= LETTERS.len() as u64;
                char::from(letter)
            })
            .collect();
        let dir = base.join(format!("{prefix}{name}"));
        #[cfg(unix)]
        let builder = {
            let mut builder = fs::DirBuilder::new();
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
            builder
        };
        #[cfg(not(unix))]
        let builder = fs::DirBuilder::new();
        match builder.create(&dir) {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && attempt < 100 => {
                attempt += 1;
            }
            Err(error) => {
                let spelled = base.join(format!("{prefix}XXXXXX"));
                return Err(NodeError::new(
                    &error,
                    "mkdtemp",
                    Some(&spelled.to_string_lossy()),
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mtime_is_nodes_double() {
        let path = std::env::temp_dir().join(format!("ompdesk-core-mtime-{}", std::process::id()));
        let file = File::create(&path).unwrap();
        file.set_modified(UNIX_EPOCH + std::time::Duration::new(1_700_000_000, 122_999_000))
            .unwrap();
        let meta = fs::metadata(&path).unwrap();
        fs::remove_file(&path).unwrap();
        // What node's `statSync(path).mtimeMs` printed for this time.
        assert_eq!(mtime_ms(&meta), 1_700_000_000_122.999);
    }

    #[test]
    fn refuses_a_nul_before_the_system_call() {
        let error = stat("/tmp/a\0b").unwrap_err();
        assert_eq!(error.code, "ERR_INVALID_ARG_VALUE");
    }

    #[test]
    fn makes_a_private_temp_folder_once_per_name() {
        let one = make_temp_dir("ompdesk-core-test-").unwrap();
        let two = make_temp_dir("ompdesk-core-test-").unwrap();
        assert_ne!(one, two);
        let name = one.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name.len(), "ompdesk-core-test-".len() + 6);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&one).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        fs::remove_dir(one).unwrap();
        fs::remove_dir(two).unwrap();
    }
}
