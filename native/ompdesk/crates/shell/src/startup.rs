//! What the shell decides before CEF starts, as pure functions: the user-data folder, the single-instance name, where
//! the app and Node are, and which of the shell's own arguments are Chromium switches.

use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

/// Test seam: a dry run keeps a relaunched app off the person's real profile with this.
pub const USER_DATA_ENV: &str = "OMP_GUI_TEST_USER_DATA_DIR";

/// `--user-data-dir=<dir>` or `--user-data-dir <dir>` among `args` (the shell's argv after the exe); the last one wins,
/// as Chromium's own switch parsing does.
pub fn user_data_switch(args: &[String]) -> Option<String> {
    let mut found = None;
    let mut i = 0;
    while i < args.len() {
        if let Some(value) = args[i].strip_prefix("--user-data-dir=") {
            found = Some(value.to_string());
        } else if args[i] == "--user-data-dir" && i + 1 < args.len() {
            found = Some(args[i + 1].clone());
            i += 1;
        }
        i += 1;
    }
    found.filter(|v| !v.is_empty())
}

/// The switch, else the test seam's env value, else `default` (Electron's own rule for `app.getPath("userData")`).
pub fn resolve_user_data(args: &[String], env_value: Option<&str>, default: PathBuf) -> PathBuf {
    if let Some(dir) = user_data_switch(args) {
        return PathBuf::from(dir);
    }
    match env_value {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => default,
    }
}

/// The folder Electron used for `userData` without a switch: `<roaming app data>\ompdesk` (Windows), `~/Library/Application Support/ompdesk` (macOS).
pub fn default_user_data(roaming_app_data: &Path) -> PathBuf {
    roaming_app_data.join("ompdesk")
}

/// Windows: `\\.\pipe\ompdesk-shell-<first 16 hex digits of SHA-256(lower-cased user-data path)>`. The path is the
/// string as given, lower-cased, so two spellings of one folder differing only in case name one instance.
pub fn pipe_name(user_data: &Path) -> String {
    format!("\\\\.\\pipe\\ompdesk-shell-{}", instance_hash(user_data))
}

/// The first 16 hex digits of SHA-256 over the lower-cased user-data path.
pub fn instance_hash(user_data: &Path) -> String {
    let digest = Sha256::digest(user_data.to_string_lossy().to_lowercase().as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// The longest unix socket path used (`sun_path` is 104 bytes on macOS, 108 on Linux, with the terminating NUL).
const SOCKET_PATH_MAX: usize = 100;

/// A unix socket for `tag`: `ompdesk-<instance hash>-<tag>.sock` in `tmp` (the per-user temp folder), `/tmp` when that
/// would pass `sun_path`'s limit. Never under the profile, whose path can be long (the e2e profiles are); the hash is of the
/// user-data path, so a second launch of the same profile computes the same name, and two profiles never share one.
pub fn unix_socket_path(user_data: &Path, tmp: &Path, tag: &str) -> PathBuf {
    let file = format!("ompdesk-{}-{tag}.sock", instance_hash(user_data));
    let beside = tmp.join(&file);
    if beside.as_os_str().len() <= SOCKET_PATH_MAX {
        return beside;
    }
    Path::new("/tmp").join(file)
}

/// macOS: the unix socket a second launch hands its arguments to.
pub fn socket_path(user_data: &Path) -> PathBuf {
    unix_socket_path(user_data, &std::env::temp_dir(), "shell")
}

/// macOS: the unix socket Node connects to, one per shell process.
pub fn host_socket_path(user_data: &Path, pid: u32) -> PathBuf {
    unix_socket_path(user_data, &std::env::temp_dir(), &format!("host-{pid}"))
}

/// The folder holding `out/main/index.js`, found by walking up from `start`.
pub fn find_app_dir(start: &Path, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if exists(&d.join("out").join("main").join("index.js")) {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// A Chromium switch among the shell's arguments: its name without the dashes (`remote-debugging-port`), and its value.
pub fn switch_of(arg: &str) -> Option<(&str, Option<&str>)> {
    let body = arg.strip_prefix("--")?;
    if body.is_empty() || body.starts_with(['-', '=']) {
        return None;
    }
    Some(match body.split_once('=') {
        Some((name, value)) => (name, Some(value)),
        None => (body, None),
    })
}

/// `--remote-debugging-port=<n>` among `args`; `Some(0)` asks Chromium for a free port.
pub fn remote_debugging_port(args: &[String]) -> Option<u16> {
    args.iter().rev().find_map(|arg| match switch_of(arg) {
        Some(("remote-debugging-port", Some(value))) => value.parse().ok(),
        _ => None,
    })
}

/// True when `rel` stays inside its root: only plain names, no `..`, no drive, no root.
pub fn is_plain_relative(rel: &str) -> bool {
    // A drive (`C:`) or a backslash is no plain name on any platform, whatever this one's path rules say.
    !rel.contains([':', '\\'])
        && Path::new(rel)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn user_data_comes_from_the_switch_then_the_seam_then_the_default() {
        let default = PathBuf::from("C:/Users/x/AppData/Roaming/ompdesk");
        assert_eq!(
            resolve_user_data(
                &args(&["--user-data-dir=D:/t"]),
                Some("E:/seam"),
                default.clone()
            ),
            PathBuf::from("D:/t")
        );
        assert_eq!(
            resolve_user_data(&args(&["--user-data-dir", "D:/t2"]), None, default.clone()),
            PathBuf::from("D:/t2")
        );
        assert_eq!(
            resolve_user_data(&args(&[]), Some("E:/seam"), default.clone()),
            PathBuf::from("E:/seam")
        );
        assert_eq!(
            resolve_user_data(&args(&["--foo"]), Some(""), default.clone()),
            default
        );
        assert_eq!(
            resolve_user_data(&args(&["--user-data-dir="]), None, default.clone()),
            default
        );
    }

    #[test]
    fn the_last_user_data_switch_wins_and_a_trailing_bare_one_is_ignored() {
        assert_eq!(
            user_data_switch(&args(&["--user-data-dir=a", "--user-data-dir", "b"])).as_deref(),
            Some("b")
        );
        assert_eq!(user_data_switch(&args(&["--user-data-dir"])), None);
    }

    #[test]
    fn the_pipe_is_named_by_sha256_of_the_lower_cased_path() {
        // sha256("c:\users\x\appdata\roaming\ompdesk"), first 8 bytes.
        let name = pipe_name(Path::new("C:\\Users\\X\\AppData\\Roaming\\ompdesk"));
        assert_eq!(
            name,
            pipe_name(Path::new("c:\\users\\x\\appdata\\roaming\\OMPDESK"))
        );
        assert!(name.starts_with("\\\\.\\pipe\\ompdesk-shell-"));
        assert_eq!(name.len(), "\\\\.\\pipe\\ompdesk-shell-".len() + 16);
        assert!(
            name.rsplit('-')
                .next()
                .unwrap()
                .chars()
                .all(|c| c.is_ascii_hexdigit())
        );
        assert_ne!(name, pipe_name(Path::new("C:\\Users\\X\\other")));
    }

    #[test]
    fn the_instance_hash_is_a_known_sha256_prefix() {
        // printf 'abc' | sha256sum = ba7816bf8f01cfea…
        assert_eq!(instance_hash(Path::new("ABC")), "ba7816bf8f01cfea");
    }

    #[test]
    fn the_app_dir_is_the_nearest_folder_above_holding_the_main_script() {
        let exists = |p: &Path| p == Path::new("/repo/out/main/index.js");
        assert_eq!(
            find_app_dir(Path::new("/repo/resources/ompdesk-shell/win32-x64"), exists),
            Some(PathBuf::from("/repo"))
        );
        assert_eq!(find_app_dir(Path::new("/elsewhere/bin"), exists), None);
    }

    #[test]
    fn switches_are_read_with_and_without_values() {
        assert_eq!(switch_of("--lang=ko"), Some(("lang", Some("ko"))));
        assert_eq!(
            switch_of("--ignore-certificate-errors"),
            Some(("ignore-certificate-errors", None))
        );
        assert_eq!(switch_of("omp://open"), None);
        assert_eq!(switch_of("--"), None);
        assert_eq!(switch_of("--=x"), None);
        assert_eq!(
            remote_debugging_port(&args(&["--remote-debugging-port=0", "--x"])),
            Some(0)
        );
        assert_eq!(
            remote_debugging_port(&args(&[
                "--remote-debugging-port=9222",
                "--remote-debugging-port=9333"
            ])),
            Some(9333)
        );
        assert_eq!(
            remote_debugging_port(&args(&["--remote-debugging-port=nope"])),
            None
        );
    }

    #[test]
    fn a_socket_path_is_short_and_one_per_user_data_folder() {
        let tmp = Path::new("/var/folders/xx/yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy/T");
        let long = Path::new(
            "/var/folders/xx/yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy/T/ompdesk-run-1234-abcdef/omp-gui-smoke-abcdef/desktop",
        );
        let path = unix_socket_path(long, tmp, "shell");
        assert!(path.starts_with(tmp));
        assert!(path.as_os_str().len() <= SOCKET_PATH_MAX);
        assert_eq!(path, unix_socket_path(long, tmp, "shell"));
        assert_ne!(path, unix_socket_path(Path::new("/other"), tmp, "shell"));
        let host = unix_socket_path(long, tmp, "host-77");
        assert_ne!(host, path, "the host socket is another file");
        assert!(host.as_os_str().len() <= SOCKET_PATH_MAX);
        // A temp folder that is itself long falls back to /tmp.
        let long_tmp = Path::new(
            "/var/folders/xx/yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy/T/with/a/very/long/path/of/its/own/that/is/too/much",
        );
        let fallback = unix_socket_path(long, long_tmp, "shell");
        assert!(fallback.starts_with("/tmp"));
        assert!(fallback.as_os_str().len() <= SOCKET_PATH_MAX);
    }

    #[test]
    fn relative_paths_must_stay_inside() {
        assert!(is_plain_relative("assets/a.js"));
        assert!(!is_plain_relative("../a"));
        assert!(!is_plain_relative("/a"));
        assert!(!is_plain_relative("C:/a"));
    }
}
