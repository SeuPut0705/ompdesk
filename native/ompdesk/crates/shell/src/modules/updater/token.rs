//! The optional GitHub token (was `src/main/update-auth.ts`). The release repo is public, so updates work with none; a
//! token only raises GitHub's rate limit and keeps updates working if the repo is private again. Never bundled.
//! Precedence: `GH_TOKEN`/`GITHUB_TOKEN` (Node's launch environment, then the login shell's, `updater.loginEnv`), then
//! `gh auth token`, then a token pasted in Settings › Updates, kept in `<userData>/update-token.bin` under
//! `safeStorage`'s key.
//!
//! The key is read only when a stored token exists or one is saved: on macOS the keychain item is read with dialogs
//! off, and a read that would ask drops the stored token (its file removed, `update-token.dropped` left with the
//! reason) instead; nothing touches the keychain again that run. The token never leaves the shell.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use shell_core::updater_core::rules::{self, classify_repo_access};
use shell_core::updater_core::secret::{KEYCHAIN_WOULD_ASK, Key};
use shell_core::updater_core::status::Access;

use super::fetch::{self, Redirect};
use super::service::Service;

const GH_TIMEOUT: Duration = Duration::from_secs(5);
/// The repository probe's deadline: a connection that never answers reads as a network failure.
const REPO_ACCESS_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Env,
    Gh,
    Stored,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Env => "env",
            Source::Gh => "gh",
            Source::Stored => "stored",
        }
    }
}

fn token_file(user_data: &Path) -> PathBuf {
    user_data.join("update-token.bin")
}

fn dropped_file(user_data: &Path) -> PathBuf {
    user_data.join("update-token.dropped")
}

/// The key, read once per run (a refused read is never repeated).
static KEY: Mutex<Option<Result<Key, String>>> = Mutex::new(None);

fn read_key(user_data: &Path) -> Result<Key, String> {
    #[cfg(target_os = "macos")]
    {
        use base64::Engine;
        let answer = shell_core::sys_mac::keychain::key_json(user_data);
        match answer["password"].as_str() {
            Some(password) => base64::engine::general_purpose::STANDARD
                .decode(password)
                .map(Key::Mac)
                .map_err(|e| e.to_string()),
            None => Err(answer["unavailable"]
                .as_str()
                .unwrap_or("the keychain gave no key")
                .to_string()),
        }
    }
    #[cfg(windows)]
    {
        shell_core::migrate::safe_storage::windows_key(user_data).map(Key::Windows)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = user_data;
        Err("safeStorage is read on Windows and macOS only".to_string())
    }
}

fn key(user_data: &Path) -> Result<Key, String> {
    let mut slot = KEY.lock().unwrap();
    slot.get_or_insert_with(|| read_key(user_data)).clone()
}

fn drop_stored(service: &Service, reason: &str) {
    let user_data = service.user_data();
    let _ = std::fs::remove_file(token_file(user_data));
    let _ = write_private(&dropped_file(user_data), reason.as_bytes());
    service.log_line(&format!(
        "The saved update token was removed: it cannot be read on this computer ({reason}); GH_TOKEN, GITHUB_TOKEN and the gh login still apply"
    ));
}

fn write_private(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    options.open(file)?.write_all(bytes)
}

/// `gh auth token --hostname github.com` with the login shell's `PATH`, 5 s at most, no window.
fn gh_token(path: &str) -> Option<String> {
    let name = if cfg!(windows) { "gh.exe" } else { "gh" };
    let mut command = Command::new(name);
    command
        .args(["auth", "token", "--hostname", "github.com"])
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + GH_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                use std::io::Read;
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                return status.success().then_some(out);
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn stored_token(service: &Service) -> Option<String> {
    let blob = std::fs::read(token_file(service.user_data())).ok()?;
    match key(service.user_data()) {
        Ok(key) => key.decrypt(&blob).ok(),
        Err(reason) => {
            // The key was refused without a dialog: the token never decrypts on this computer, so it goes.
            if reason == KEYCHAIN_WOULD_ASK {
                drop_stored(service, KEYCHAIN_WOULD_ASK);
            }
            None
        }
    }
}

/// The first usable token in precedence order; lookups run lazily, so one in the environment never starts `gh`.
pub fn resolve(service: &Service) -> Option<(String, Source)> {
    let env = service.login_env();
    let lookups: [(Source, &dyn Fn() -> Option<String>); 3] = [
        (Source::Env, &|| env.token.clone()),
        (Source::Gh, &|| gh_token(&env.path)),
        (Source::Stored, &|| stored_token(service)),
    ];
    for (source, lookup) in lookups {
        if let Some(token) = lookup()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
        {
            return Some((token, source));
        }
    }
    None
}

/// Whether the release repo is readable with `token`, or anonymously without one.
pub fn repo_access(service: &Service, token: Option<&str>) -> Access {
    let headers = rules::github_api_headers(token, None);
    match fetch::get(
        service.api(),
        &headers,
        Redirect::Follow,
        false,
        REPO_ACCESS_TIMEOUT,
    ) {
        Ok(response) => classify_repo_access(
            response.status,
            response.header("x-ratelimit-remaining") == Some("0"),
        ),
        Err(_) => Access::Network,
    }
}

/// `UpdateAuthInfo`.
pub fn info(service: &Service) -> Value {
    let resolved = resolve(service);
    // After the resolve: a token it just dropped is no longer stored, and says why.
    let user_data = service.user_data();
    let stored = token_file(user_data).exists();
    let dropped = std::fs::read_to_string(dropped_file(user_data))
        .ok()
        .map(|reason| reason.trim().to_string())
        .filter(|reason| !reason.is_empty());
    json!({
        "droppedReason": dropped,
        "source": resolved.map(|(_, source)| source.as_str()),
        "hasStoredToken": stored,
        // macOS and Windows always have an OS keystore; probing it could ask (see the module docs).
        "canStore": true,
    })
}

/// `UpdateAuthTestResult` for `token`, or for the token the next check would use.
pub fn test(service: &Service, token: Option<&str>) -> Value {
    if let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) {
        return json!({ "access": repo_access(service, Some(token)).as_str(), "source": null });
    }
    let resolved = resolve(service);
    let access = repo_access(service, resolved.as_ref().map(|(t, _)| t.as_str()));
    match resolved {
        // Anonymous and refused: the repo is private, so a token is what is missing.
        None => {
            json!({ "access": if access == Access::Denied { "missing" } else { access.as_str() }, "source": null })
        }
        Some((_, source)) => json!({ "access": access.as_str(), "source": source.as_str() }),
    }
}

/// Stores `token` when the repository answers `ok` to it. Errors: `(code, message)`.
pub fn save(service: &Service, token: &str) -> Result<Value, (&'static str, String)> {
    let token = token.trim();
    if token.is_empty() {
        return Ok(json!({ "access": "missing", "source": null }));
    }
    let access = repo_access(service, Some(token));
    if access == Access::Ok {
        let key = key(service.user_data()).map_err(|reason| {
            if reason == KEYCHAIN_WOULD_ASK {
                (
                    "keychain_would_ask",
                    "macOS would ask for the login password to open the keychain".to_string(),
                )
            } else {
                (
                    "safe_storage_unavailable",
                    "safeStorage encryption is unavailable".to_string(),
                )
            }
        })?;
        let blob = key
            .encrypt(token)
            .map_err(|e| ("safe_storage_unavailable", e))?;
        write_private(&token_file(service.user_data()), &blob)
            .map_err(|e| ("failed", e.to_string()))?;
        let _ = std::fs::remove_file(dropped_file(service.user_data()));
    }
    Ok(
        json!({ "access": access.as_str(), "source": if access == Access::Ok { Some("stored") } else { None } }),
    )
}

pub fn clear(service: &Service) {
    let _ = std::fs::remove_file(token_file(service.user_data()));
    let _ = std::fs::remove_file(dropped_file(service.user_data()));
}
