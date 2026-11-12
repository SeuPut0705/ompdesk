//! How the control socket's folder, token and endpoint file are protected (was the disk side of
//! `src/main/control-socket/endpoint.ts`). The socket answers anyone who holds the token, so everything here keeps
//! the folder, the token and the endpoint file readable by this user only. Main names the paths (`controlEndpoint`)
//! and says whose uid counts (its own; none on Windows, where the folder's access list is the user's own).

use std::fs;
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

use super::js;
use crate::fs::error::{Codes, NodeError};
use crate::server::Fault;

pub const ENDPOINT_FILE: &str = "endpoint.json";
pub const TOKEN_FILE: &str = "token";

#[cfg(unix)]
const OWNER_ONLY_DIR: u32 = 0o700;
#[cfg(unix)]
const OWNER_ONLY_FILE: u32 = 0o600;
#[cfg(unix)]
const GROUP_OR_OTHER: u32 = 0o077;

fn io_fault(error: &io::Error, syscall: &str, path: &Path) -> Fault {
    NodeError::new(error, syscall, Some(&path.to_string_lossy())).fault(Codes::None)
}

#[cfg(unix)]
fn refused(dir: &str, reason: &str) -> Fault {
    Fault::new(
        "control_dir_refused",
        format!("Control folder {dir} refused: {reason}"),
    )
}

/// Makes the folder (owner only) and refuses one that is a link or another user's; repairs loose mode bits on ours.
/// True when it had to repair them: whatever the folder held may have been read meanwhile.
pub fn prepare_dir(dir: &str, uid: Option<u32>) -> Result<bool, Fault> {
    let path = Path::new(dir);
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, OWNER_ONLY_DIR);
    builder
        .create(path)
        .map_err(|error| io_fault(&error, "mkdir", path))?;
    let Some(uid) = uid else {
        return Ok(false);
    };
    owner_only_dir(dir, path, uid)
}

#[cfg(unix)]
fn owner_only_dir(dir: &str, path: &Path, uid: u32) -> Result<bool, Fault> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let meta = fs::symlink_metadata(path).map_err(|error| io_fault(&error, "lstat", path))?;
    if !meta.file_type().is_dir() {
        return Err(refused(dir, "not a real folder"));
    }
    if meta.uid() != uid {
        return Err(refused(dir, "owned by another user"));
    }
    if meta.mode() & GROUP_OR_OTHER == 0 {
        return Ok(false);
    }
    fs::set_permissions(path, fs::Permissions::from_mode(OWNER_ONLY_DIR))
        .map_err(|error| io_fault(&error, "chmod", path))?;
    Ok(true)
}

#[cfg(not(unix))]
fn owner_only_dir(_dir: &str, _path: &Path, _uid: u32) -> Result<bool, Fault> {
    Ok(false)
}

/// Whether the token file is a plain file of `uid` that nobody else can read.
#[cfg(unix)]
fn owner_only_file(path: &Path, uid: u32) -> bool {
    use std::os::unix::fs::MetadataExt;
    fs::symlink_metadata(path).is_ok_and(|meta| {
        meta.file_type().is_file() && meta.uid() == uid && meta.mode() & GROUP_OR_OTHER == 0
    })
}

#[cfg(not(unix))]
fn owner_only_file(_path: &Path, _uid: u32) -> bool {
    true
}

fn is_token(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The install's token: 64 hex characters, made on first use, whenever the file is damaged, and whenever someone else
/// could have read it (`exposed`: the folder was open to others before `prepare_dir` repaired it; or the file is open
/// to others or another user's).
pub fn token(dir: &str, uid: Option<u32>, exposed: bool) -> Result<String, Fault> {
    let file = Path::new(dir).join(TOKEN_FILE);
    let existing = fs::read(&file)
        .ok()
        .map(|bytes| js::trim(&String::from_utf8_lossy(&bytes)).to_owned());
    if let Some(existing) = existing
        && !exposed
        && is_token(&existing)
        && uid.is_none_or(|uid| owner_only_file(&file, uid))
    {
        return Ok(existing);
    }
    // A file another user owns cannot be chmodded or replaced in place: it goes (the folder is ours).
    remove(&file)?;
    let mut bytes = [0u8; 32];
    crate::sys::random(&mut bytes).map_err(|error| Fault::new("io", error.to_string()))?;
    let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    write_atomic(&file, &format!("{token}\n"))?;
    Ok(token)
}

/// `rmSync(file, { force: true })`.
fn remove(file: &Path) -> Result<(), Fault> {
    match fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_fault(&error, "rm", file)),
    }
}

/// Windows refuses a rename over a file another process has open (a virus scan, an indexer): these are tried again.
#[cfg(windows)]
fn rename_blocked(error: &io::Error) -> bool {
    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_LOCK_VIOLATION: i32 = 33;
    matches!(
        error.raw_os_error(),
        Some(ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)
    )
}

#[cfg(not(windows))]
fn rename_blocked(_error: &io::Error) -> bool {
    false
}

/// The waits of main's `writeFileAtomicSync` (`atomic-file.ts`), in milliseconds.
const RENAME_RETRY_MS: [u64; 6] = [10, 20, 40, 80, 160, 320];

/// Replaces `file` with `data` in one step, owner only: a sibling temp file, then a rename over the target, as main's
/// `writeFileAtomicSync` does (the same temp name shape, mode and retries).
fn write_atomic(file: &Path, data: &str) -> Result<(), Fault> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| io_fault(&error, "mkdir", parent))?;
    }
    let temp = {
        let mut name = file.as_os_str().to_owned();
        name.push(format!(
            ".{}-{}.tmp",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::path::PathBuf::from(name)
    };
    let staged = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, OWNER_ONLY_FILE);
        let mut handle = options
            .open(&temp)
            .map_err(|error| io_fault(&error, "open", &temp))?;
        handle
            .write_all(data.as_bytes())
            .map_err(|error| io_fault(&error, "write", &temp))?;
        drop(handle);
        // The creation mode is masked by the umask: pinned after the write.
        #[cfg(unix)]
        fs::set_permissions(
            &temp,
            std::os::unix::fs::PermissionsExt::from_mode(OWNER_ONLY_FILE),
        )
        .map_err(|error| io_fault(&error, "chmod", &temp))?;
        let mut attempt = 0;
        loop {
            match fs::rename(&temp, file) {
                Ok(()) => return Ok(()),
                Err(error) => match RENAME_RETRY_MS.get(attempt) {
                    Some(wait) if rename_blocked(&error) => {
                        std::thread::sleep(std::time::Duration::from_millis(*wait));
                        attempt += 1;
                    }
                    _ => {
                        return Err(NodeError::with_dest(
                            &error,
                            "rename",
                            Some(&temp.to_string_lossy()),
                            Some(&file.to_string_lossy()),
                        )
                        .fault(Codes::None));
                    }
                },
            }
        }
    })();
    if staged.is_err() {
        let _ = fs::remove_file(&temp);
    }
    staged
}

/// Publishes where this OMPdesk listens: `endpoint` is the file's JSON as main wrote it.
pub fn write_endpoint(dir: &str, endpoint: &str) -> Result<(), Fault> {
    write_atomic(
        &Path::new(dir).join(ENDPOINT_FILE),
        &format!("{endpoint}\n"),
    )
}

/// Removes `endpoint.json` only while it still names `socket`: a newer OMPdesk's file is not ours to delete.
pub fn remove_endpoint(dir: &str, socket: &str) -> Result<(), Fault> {
    let file = Path::new(dir).join(ENDPOINT_FILE);
    let Ok(bytes) = fs::read(&file) else {
        return Ok(());
    };
    let text = String::from_utf8_lossy(&bytes);
    // A damaged file names nothing of ours.
    let names_it = serde_json::from_str::<Value>(&crate::json::whole_surrogates(&text))
        .is_ok_and(|parsed| parsed.get("socket").and_then(Value::as_str) == Some(socket));
    if names_it {
        remove(&file)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::disk::make_temp_dir;

    fn temp() -> (std::path::PathBuf, String) {
        let root = make_temp_dir("ompdesk-core-control-").unwrap();
        let dir = root.join("control").to_string_lossy().into_owned();
        (root, dir)
    }

    #[test]
    fn makes_a_token_once_and_replaces_a_damaged_or_exposed_one() {
        let (root, dir) = temp();
        assert!(!prepare_dir(&dir, None).unwrap());
        let first = token(&dir, None, false).unwrap();
        assert!(is_token(&first));
        let file = Path::new(&dir).join(TOKEN_FILE);
        assert_eq!(fs::read_to_string(&file).unwrap(), format!("{first}\n"));
        assert_eq!(token(&dir, None, false).unwrap(), first);
        // Whatever the folder held may have been read: the token is replaced.
        let second = token(&dir, None, true).unwrap();
        assert!(is_token(&second));
        assert_ne!(second, first);
        for damaged in ["garbage", "", &first[..63], &first.to_uppercase()] {
            fs::write(&file, damaged).unwrap();
            let fresh = token(&dir, None, false).unwrap();
            assert!(is_token(&fresh), "{damaged}");
            assert_eq!(token(&dir, None, false).unwrap(), fresh);
        }
        // No temp file is left beside it.
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, [TOKEN_FILE]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removes_the_endpoint_file_only_while_it_names_that_socket() {
        let (root, dir) = temp();
        prepare_dir(&dir, None).unwrap();
        let file = Path::new(&dir).join(ENDPOINT_FILE);
        write_endpoint(&dir, r#"{"version":1,"socket":"/new/socket","pid":1}"#).unwrap();
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "{\"version\":1,\"socket\":\"/new/socket\",\"pid\":1}\n"
        );
        remove_endpoint(&dir, "/old/socket").unwrap();
        assert!(file.exists());
        remove_endpoint(&dir, "/new/socket").unwrap();
        assert!(!file.exists());
        remove_endpoint(&dir, "/new/socket").unwrap();
        for damaged in ["", "nope", "[]", "null", r#"{"socket":5}"#] {
            fs::write(&file, damaged).unwrap();
            remove_endpoint(&dir, "/new/socket").unwrap();
            assert!(file.exists(), "{damaged}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn says_why_a_folder_cannot_be_made() {
        let (root, _) = temp();
        let blocker = root.join("file");
        fs::write(&blocker, "not a folder").unwrap();
        let dir = blocker.join("control").to_string_lossy().into_owned();
        let fault = prepare_dir(&dir, None).unwrap_err();
        assert_eq!(fault.code, "io");
        assert!(fault.message.contains(", mkdir '"), "{}", fault.message);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    mod unix {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        use super::*;

        fn mode(path: impl AsRef<Path>) -> u32 {
            fs::metadata(path).unwrap().mode() & 0o777
        }

        fn uid_of(path: impl AsRef<Path>) -> u32 {
            fs::metadata(path).unwrap().uid()
        }

        #[test]
        fn makes_the_folder_and_the_files_this_users_alone() {
            let (root, dir) = temp();
            let uid = uid_of(&root);
            assert!(!prepare_dir(&dir, Some(uid)).unwrap());
            assert_eq!(mode(&dir), 0o700);
            token(&dir, Some(uid), false).unwrap();
            assert_eq!(mode(Path::new(&dir).join(TOKEN_FILE)), 0o600);
            write_endpoint(&dir, "{}").unwrap();
            assert_eq!(mode(Path::new(&dir).join(ENDPOINT_FILE)), 0o600);
            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn repairs_a_folder_and_a_token_that_were_open_to_others() {
            for (dir_mode, token_mode) in [(0o755, 0o644), (0o755, 0o600), (0o700, 0o644)] {
                let (root, dir) = temp();
                let uid = uid_of(&root);
                fs::create_dir_all(&dir).unwrap();
                fs::set_permissions(&dir, fs::Permissions::from_mode(dir_mode)).unwrap();
                let file = Path::new(&dir).join(TOKEN_FILE);
                let old = "ab".repeat(32);
                fs::write(&file, &old).unwrap();
                fs::set_permissions(&file, fs::Permissions::from_mode(token_mode)).unwrap();
                let exposed = prepare_dir(&dir, Some(uid)).unwrap();
                assert_eq!(exposed, dir_mode != 0o700);
                let used = token(&dir, Some(uid), exposed).unwrap();
                assert_ne!(used, old, "{dir_mode:o} {token_mode:o}");
                assert_eq!(mode(&dir), 0o700);
                assert_eq!(mode(&file), 0o600);
                // Tight now: the next start keeps it.
                assert!(!prepare_dir(&dir, Some(uid)).unwrap());
                assert_eq!(token(&dir, Some(uid), false).unwrap(), used);
                fs::remove_dir_all(root).unwrap();
            }
        }

        #[test]
        fn replaces_a_token_file_another_user_owns() {
            let (root, dir) = temp();
            let uid = uid_of(&root);
            prepare_dir(&dir, Some(uid)).unwrap();
            let old = "cd".repeat(32);
            let file = Path::new(&dir).join(TOKEN_FILE);
            fs::write(&file, &old).unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
            assert_eq!(token(&dir, Some(uid), false).unwrap(), old);
            assert_ne!(token(&dir, Some(uid + 1), false).unwrap(), old);
            fs::remove_dir_all(root).unwrap();
        }

        #[test]
        fn refuses_a_folder_owned_by_another_user_and_one_that_is_a_link() {
            let (root, dir) = temp();
            let uid = uid_of(&root);
            let other = prepare_dir(&dir, Some(uid + 1)).unwrap_err();
            assert_eq!(other.code, "control_dir_refused");
            assert_eq!(
                other.message,
                format!("Control folder {dir} refused: owned by another user")
            );
            let real = root.join("real");
            fs::create_dir(&real).unwrap();
            let link = root.join("link");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            let link = link.to_string_lossy().into_owned();
            let linked = prepare_dir(&link, Some(uid)).unwrap_err();
            assert_eq!(
                linked.message,
                format!("Control folder {link} refused: not a real folder")
            );
            fs::remove_dir_all(root).unwrap();
        }
    }
}
