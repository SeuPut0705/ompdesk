//! Where the running OMPdesk listens, and the checks made before its token goes anywhere.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::number::js_trim;
use crate::protocol::{
    CONTROL_DIR_ENV, CONTROL_OFF_ENV, CONTROL_SOCKET_ENV, ENDPOINT_FILE, TOKEN_FILE,
};
use crate::run::Io;

pub fn control_dir(env: &HashMap<String, String>, platform: &str, home: &Path) -> PathBuf {
    let set = |name: &str| env.get(name).filter(|v| !v.is_empty());
    if let Some(explicit) = set(CONTROL_DIR_ENV) {
        return PathBuf::from(explicit);
    }
    let base = match platform {
        "darwin" => home.join("Library").join("Application Support"),
        "win32" => {
            set("APPDATA").map_or_else(|| home.join("AppData").join("Roaming"), PathBuf::from)
        }
        _ => set("XDG_CONFIG_HOME").map_or_else(|| home.join(".config"), PathBuf::from),
    };
    base.join("ompdesk").join("control")
}

pub struct Endpoint {
    pub path: String,
    pub token: String,
}

/// POSIX: `path` must be `uid`'s alone (`lstat`, no group or other mode bits), so a socket another user planted, or
/// one whose folder others can write, never receives the token. Windows has no such check: there the pipe's name is
/// unguessable and published only in this user's files.
#[cfg(unix)]
pub fn owner_only(path: &Path, what: &str, uid: Option<u32>) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let meta =
        fs::symlink_metadata(path).map_err(|e| format!("{e}, lstat '{}'", path.display()))?;
    if let Some(uid) = uid
        && meta.uid() != uid
    {
        return Err(format!(
            "refused: {what} {} belongs to another user",
            path.display()
        ));
    }
    if meta.mode() & 0o077 != 0 {
        return Err(format!(
            "refused: {what} {} is open to other users",
            path.display()
        ));
    }
    Ok(())
}

pub fn read_endpoint(socket: Option<&str>, io: &Io) -> Result<Endpoint, String> {
    if io.env.get(CONTROL_OFF_ENV).is_some_and(|v| v == "1") {
        return Err("OMPdesk control is off in a session OMPdesk runs for another device (a paired computer or the phone page)".into());
    }
    let dir = control_dir(&io.env, io.platform, &io.home);
    let token_file = dir.join(TOKEN_FILE);
    let given = socket.or(io.env.get(CONTROL_SOCKET_ENV).map(String::as_str));
    let path = match given.filter(|p| !p.is_empty()) {
        Some(path) => path.to_string(),
        None => {
            let file = dir.join(ENDPOINT_FILE);
            if !file.exists() {
                return Err(format!("OMPdesk is not running (no {})", file.display()));
            }
            let endpoint: Value = fs::read_to_string(&file)
                .ok()
                .and_then(|text| serde_json::from_str(&text).ok())
                .ok_or_else(|| format!("{} is unreadable", file.display()))?;
            match endpoint.get("socket").and_then(Value::as_str) {
                Some(path) if !path.is_empty() => path.to_string(),
                _ => return Err(format!("{} names no socket", file.display())),
            }
        }
    };
    if !token_file.exists() {
        return Err(format!(
            "OMPdesk is not running or its token is missing ({})",
            token_file.display()
        ));
    }
    if io.platform != "win32" && !Path::new(&path).exists() {
        return Err(format!("OMPdesk is not running (no {path})"));
    }
    #[cfg(unix)]
    if io.platform != "win32" {
        let socket = Path::new(&path);
        let folder = match socket.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => Path::new("."),
        };
        owner_only(folder, "socket folder", io.uid)?;
        owner_only(socket, "socket", io.uid)?;
        owner_only(&token_file, "token", io.uid)?;
    }
    let token =
        fs::read(&token_file).map_err(|e| format!("{e}, open '{}'", token_file.display()))?;
    Ok(Endpoint {
        path,
        token: js_trim(&String::from_utf8_lossy(&token)).to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_dir_follows_the_platform() {
        let env = |pairs: &[(&str, &str)]| -> HashMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        let h = Path::new("/h");
        assert_eq!(
            control_dir(&env(&[("OMPDESK_CONTROL_DIR", "/c")]), "darwin", h),
            PathBuf::from("/c")
        );
        assert_eq!(
            control_dir(&env(&[]), "darwin", h),
            Path::new("/h")
                .join("Library")
                .join("Application Support")
                .join("ompdesk")
                .join("control")
        );
        assert_eq!(
            control_dir(&env(&[("APPDATA", "/a")]), "win32", h),
            Path::new("/a").join("ompdesk").join("control")
        );
        assert_eq!(
            control_dir(&env(&[]), "win32", h),
            h.join("AppData")
                .join("Roaming")
                .join("ompdesk")
                .join("control")
        );
        assert_eq!(
            control_dir(&env(&[("XDG_CONFIG_HOME", "/x")]), "linux", h),
            Path::new("/x").join("ompdesk").join("control")
        );
        assert_eq!(
            control_dir(&env(&[]), "linux", h),
            h.join(".config").join("ompdesk").join("control")
        );
        assert_eq!(
            control_dir(
                &env(&[("OMPDESK_CONTROL_DIR", ""), ("XDG_CONFIG_HOME", "")]),
                "linux",
                h
            ),
            h.join(".config").join("ompdesk").join("control")
        );
    }

    #[cfg(unix)]
    #[test]
    fn owner_only_refuses_shared_or_foreign_files() {
        use std::os::unix::fs::PermissionsExt;
        let file = std::env::temp_dir().join(format!("ompdesk-owner-{}", std::process::id()));
        fs::write(&file, "x").unwrap();
        let uid = crate::sys::uid();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(owner_only(&file, "token", uid), Ok(()));
        let foreign = owner_only(&file, "token", uid.map(|u| u + 1)).unwrap_err();
        assert!(
            foreign.starts_with("refused: token ") && foreign.ends_with("belongs to another user")
        );
        for mode in [0o640, 0o604, 0o660] {
            fs::set_permissions(&file, fs::Permissions::from_mode(mode)).unwrap();
            let open = owner_only(&file, "token", uid).unwrap_err();
            assert!(
                open.starts_with("refused: token ") && open.ends_with("is open to other users")
            );
        }
        fs::remove_file(&file).unwrap();
    }
}
