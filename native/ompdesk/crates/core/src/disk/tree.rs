//! The file system calls disk care makes, each as the node call it replaces: removal of a folder or file that never
//! follows a link out of it (`fs.rm` with `recursive`, `force`, and for build output `maxRetries`), a copy that clones
//! where the volume can (`copyFile` with `COPYFILE_FICLONE`), node's `symlink` without a type, `chmod`, `mkdir` with a
//! mode, and the atomic replace of `src/main/atomic-file.ts`. Every call first asks whether the request was cancelled:
//! a stopped request starts no more disk work, and the one call the system already has runs to its end before the
//! request answers.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::fs::error::NodeError;
use crate::server::{Fault, Scope};

/// The request was cancelled: no more disk work.
pub fn live(scope: &Scope) -> Result<(), Fault> {
    if scope.cancelled() {
        Err(Fault::cancelled())
    } else {
        Ok(())
    }
}

/// A node error as the fault main reads (`io`, node's message).
pub fn fault(error: &io::Error, syscall: &str, path: &Path) -> Fault {
    NodeError::new(error, syscall, Some(&path.to_string_lossy()))
        .fault(crate::fs::error::Codes::None)
}

/// `path.join(root, ...relative.split("/"))` for the relative, `/`-separated paths git and the archive name.
pub fn under(root: &str, relative: &str) -> PathBuf {
    let mut path = PathBuf::from(root);
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                path.pop();
            }
            part => path.push(part),
        }
    }
    path
}

/// Every entry is a path inside the worktree (or archive) it is joined to: not empty, not absolute, no `..` part, not
/// the folder itself (only `.` and empty parts), and on Windows no drive, UNC or stream (`\\` starts, a `:` in a
/// part, `\\` as a separator too). Checked before a request does anything with them, so a bad list refuses the whole
/// request and nothing is touched. main's entries come from git and from main itself; the check holds the boundary.
pub fn relative_entries<'a>(entries: impl IntoIterator<Item = &'a str>) -> Result<(), Fault> {
    for entry in entries {
        let windows = cfg!(windows);
        let absolute = entry.starts_with('/') || (windows && entry.starts_with('\\'));
        let parts: Vec<&str> = entry
            .split(|c| c == '/' || (windows && c == '\\'))
            .collect();
        let escapes = parts
            .iter()
            .any(|part| *part == ".." || (windows && part.contains(':')));
        let names_nothing = parts.iter().all(|part| part.is_empty() || *part == ".");
        if absolute || escapes || names_nothing || entry.contains('\0') {
            return Err(Fault::new(
                "invalid_entry",
                format!("\"{entry}\" is not a path inside the worktree; nothing was done."),
            ));
        }
    }
    Ok(())
}

/// `fs.rm(target, { recursive: true, force: true })`: a missing target is no error; a link, a junction included, is
/// removed itself and never followed. `retries` is node's `maxRetries: 3`: a busy, not-empty or refused removal
/// (another process still closing a file, an indexer) is tried again after 100, 200 and 300 ms.
pub fn remove(target: &Path, retries: bool, scope: &Scope) -> Result<(), Fault> {
    let mut attempt = 0;
    loop {
        live(scope)?;
        match remove_tree(target, scope) {
            Ok(()) => return Ok(()),
            Err(Removal::Cancelled) => return Err(Fault::cancelled()),
            Err(Removal::Failed(error, syscall, path)) => {
                let transient = matches!(
                    crate::fs::error::uv_code(&error),
                    "EBUSY" | "EMFILE" | "ENFILE" | "ENOTEMPTY" | "EPERM"
                );
                if !retries || !transient || attempt == 3 {
                    return Err(fault(&error, syscall, &path));
                }
                attempt += 1;
                std::thread::sleep(Duration::from_millis(100 * attempt));
            }
        }
    }
}

enum Removal {
    Cancelled,
    Failed(io::Error, &'static str, PathBuf),
}

fn remove_tree(target: &Path, scope: &Scope) -> Result<(), Removal> {
    let meta = match fs::symlink_metadata(target) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(Removal::Failed(error, "lstat", target.to_owned())),
    };
    if meta.is_dir() {
        let entries = fs::read_dir(target)
            .map_err(|error| Removal::Failed(error, "scandir", target.to_owned()))?;
        for entry in entries {
            if scope.cancelled() {
                return Err(Removal::Cancelled);
            }
            let entry =
                entry.map_err(|error| Removal::Failed(error, "scandir", target.to_owned()))?;
            remove_tree(&entry.path(), scope)?;
        }
        return match fs::remove_dir(target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(Removal::Failed(error, "rmdir", target.to_owned())),
        };
    }
    match unlink(target, &meta) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(Removal::Failed(error, "unlink", target.to_owned())),
    }
}

#[cfg(not(windows))]
fn unlink(target: &Path, _meta: &fs::Metadata) -> io::Result<()> {
    fs::remove_file(target)
}

/// A link to a folder (a directory symlink or a junction) is a folder entry on Windows, and a read-only file (git's
/// objects) refuses deletion until its attribute is cleared, which node's `rm` does (`fixWinEPERM`).
#[cfg(windows)]
#[allow(
    clippy::permissions_set_readonly_false,
    reason = "Windows only: it clears the read-only attribute, it makes nothing world-writable"
)]
fn unlink(target: &Path, meta: &fs::Metadata) -> io::Result<()> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
    if meta.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0 {
        return fs::remove_dir(target);
    }
    match fs::remove_file(target) {
        Err(error)
            if error.kind() == io::ErrorKind::PermissionDenied && meta.permissions().readonly() =>
        {
            let mut permissions = meta.permissions();
            permissions.set_readonly(false);
            fs::set_permissions(target, permissions)?;
            fs::remove_file(target)
        }
        other => other,
    }
}

/// `copyFile(from, to, COPYFILE_FICLONE)`: a clone where the volume makes one (APFS, Btrfs, XFS, ReFS), else a copy.
pub fn copy(from: &Path, to: &Path) -> Result<(), Fault> {
    fs::copy(from, to).map(|_| ()).map_err(|error| {
        NodeError::with_dest(
            &error,
            "copyfile",
            Some(&from.to_string_lossy()),
            Some(&to.to_string_lossy()),
        )
        .fault(crate::fs::error::Codes::None)
    })
}

/// `chmod(path, mode)`; on Windows only the write bit means anything (node's read-only attribute).
pub fn chmod(path: &Path, mode: u32) -> Result<(), Fault> {
    #[cfg(unix)]
    let permissions = {
        use std::os::unix::fs::PermissionsExt;
        fs::Permissions::from_mode(mode)
    };
    #[cfg(not(unix))]
    let permissions = {
        let mut permissions = fs::metadata(path)
            .map_err(|error| fault(&error, "chmod", path))?
            .permissions();
        permissions.set_readonly(mode & 0o200 == 0);
        permissions
    };
    fs::set_permissions(path, permissions).map_err(|error| fault(&error, "chmod", path))
}

/// `mkdir(path, { recursive: true, mode })`: every folder it makes gets `mode` (less the umask).
pub fn make_dirs(path: &Path, mode: u32) -> Result<(), Fault> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, mode);
    #[cfg(not(unix))]
    let _ = mode;
    builder
        .create(path)
        .map_err(|error| fault(&error, "mkdir", path))
}

/// `symlink(target, path)` with no type: a link's text as it was read; on Windows a folder link when the text names
/// a folder (node looks it up from the link's folder), else a file link.
pub fn symlink(text: &Path, path: &Path) -> Result<(), Fault> {
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(text, path);
    #[cfg(windows)]
    let made = {
        let base = path.parent().unwrap_or(Path::new(""));
        if base.join(text).is_dir() {
            std::os::windows::fs::symlink_dir(text, path)
        } else {
            std::os::windows::fs::symlink_file(text, path)
        }
    };
    made.map_err(|error| {
        NodeError::with_dest(
            &error,
            "symlink",
            Some(&text.to_string_lossy()),
            Some(&path.to_string_lossy()),
        )
        .fault(crate::fs::error::Codes::None)
    })
}

/// `readlink(path)`.
pub fn read_link(path: &Path) -> Result<PathBuf, Fault> {
    fs::read_link(path).map_err(|error| fault(&error, "readlink", path))
}

/// Waits of a refused rename (`RETRY_MS` in `atomic-file.ts`): 20 ms doubling, about 5 s in all.
const RENAME_RETRY_MS: [u64; 8] = [20, 40, 80, 160, 320, 640, 1_280, 2_560];

/// `writeFileAtomic(file, bytes, { mode, dirMode, commitIf })` of `src/main/atomic-file.ts`: written to a sibling
/// temp file, then renamed over `file`, so a crash never leaves half a file. Windows refuses that rename (`EPERM`,
/// `EACCES`, `EBUSY`) while any process holds the target open, so it is tried again on that backoff. Right before
/// every rename the request is asked whether it was cancelled: a cancelled one drops the write and never replaces
/// the file.
pub fn write_atomic(
    file: &Path,
    bytes: &[u8],
    mode: u32,
    dir_mode: u32,
    scope: &Scope,
) -> Result<bool, Fault> {
    live(scope)?;
    if let Some(dir) = file.parent() {
        make_dirs(dir, dir_mode)?;
    }
    let temp = PathBuf::from(format!(
        "{}.{}-{}.tmp",
        file.to_string_lossy(),
        std::process::id(),
        next_temp()
    ));
    let written = (|| {
        fs::write(&temp, bytes).map_err(|error| fault(&error, "open", &temp))?;
        chmod(&temp, mode)?;
        for wait in RENAME_RETRY_MS.iter().map(Some).chain([None]) {
            if scope.cancelled() {
                return Ok(false);
            }
            match fs::rename(&temp, file) {
                Ok(()) => return Ok(true),
                Err(error) => match wait {
                    Some(wait) if rename_blocked(&error) => {
                        std::thread::sleep(Duration::from_millis(*wait));
                    }
                    _ => {
                        return Err(NodeError::with_dest(
                            &error,
                            "rename",
                            Some(&temp.to_string_lossy()),
                            Some(&file.to_string_lossy()),
                        )
                        .fault(crate::fs::error::Codes::None));
                    }
                },
            }
        }
        Ok(false)
    })();
    if !matches!(written, Ok(true)) {
        let _ = fs::remove_file(&temp);
    }
    written
}

fn next_temp() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// `isRenameBlocked`: a held target refuses the rename on Windows only; elsewhere a refusal is real.
fn rename_blocked(error: &io::Error) -> bool {
    cfg!(windows)
        && matches!(
            crate::fs::error::uv_code(error),
            "EPERM" | "EACCES" | "EBUSY"
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ompdesk-core-tree-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    #[test]
    fn removes_a_folder_without_following_a_link_out_of_it() {
        let dir = temp("remove");
        let outside = dir.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("kept.txt"), "kept").unwrap();
        let target = dir.join("target");
        fs::create_dir_all(target.join("deep/er")).unwrap();
        fs::write(target.join("deep/er/file"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, target.join("link")).unwrap();
        let readonly = target.join("deep/readonly");
        fs::write(&readonly, "r").unwrap();
        chmod(&readonly, 0o444).unwrap();
        remove(&target, true, &Scope::detached()).unwrap();
        assert!(!target.exists());
        assert_eq!(
            fs::read_to_string(outside.join("kept.txt")).unwrap(),
            "kept"
        );
        remove(&target, false, &Scope::detached()).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_an_entry_that_is_not_inside() {
        for good in ["a", "a/b/", ".env", "a/./b", "..a", "a..", "node_modules/"] {
            assert!(relative_entries([good]).is_ok(), "{good}");
        }
        for bad in [
            "",
            "/",
            "/etc",
            "../outside/",
            "a/../../b",
            ".",
            "./",
            "a/..",
            "x\0y",
        ] {
            assert_eq!(
                relative_entries(["a", bad]).unwrap_err().code,
                "invalid_entry",
                "{bad:?}"
            );
        }
        #[cfg(windows)]
        for bad in [
            "C:\\x",
            "C:x",
            "\\\\server\\share",
            "\\x",
            "a\\..\\..\\b",
            "f:stream",
        ] {
            assert_eq!(
                relative_entries([bad]).unwrap_err().code,
                "invalid_entry",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_cancelled_removal_takes_nothing() {
        let dir = temp("cancelled");
        fs::write(dir.join("file"), "x").unwrap();
        let scope = Scope::detached();
        scope.cancel();
        assert_eq!(remove(&dir, false, &scope).unwrap_err(), Fault::cancelled());
        assert!(dir.join("file").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn replaces_a_file_whole_and_never_after_a_cancel() {
        let dir = temp("atomic");
        let file = dir.join("nested/state.json");
        assert!(write_atomic(&file, b"one", 0o600, 0o700, &Scope::detached()).unwrap());
        assert_eq!(fs::read(&file).unwrap(), b"one");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let scope = Scope::detached();
        scope.cancel();
        assert!(write_atomic(&file, b"two", 0o600, 0o700, &scope).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"one");
        let left: Vec<_> = fs::read_dir(dir.join("nested")).unwrap().collect();
        assert_eq!(left.len(), 1, "no temp file is left");
        let _ = fs::remove_dir_all(&dir);
    }
}
