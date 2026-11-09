//! Shared plumbing for the providers that shell out to a logged-in agent CLI
//! (Cursor's `agent`, omp): a private per-call workspace, an allowlisted child
//! environment, both pipes drained under one deadline with size caps, and a
//! lenient JSON answer parser for CLIs without a schema mode.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _};
use tokio::process::Command;
use tokio::time::timeout;
use uuid::Uuid;

use crate::error::{LlmError, LlmResult};
use crate::types::{ChatRequest, Role};

pub(crate) const MAX_STDOUT_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_STDERR_BYTES: usize = 64 * 1024;

/// Variables every CLI child keeps, compared ASCII-case-insensitively (Windows
/// names are case-insensitive and proxies come in both cases): identity and
/// home for the CLI's stored login and keychain, locale, temp, the session
/// bus for a Linux keyring, proxy and CA settings, and the Windows process
/// basics.
const BASE_CHILD_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TERM",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
];

/// The subset of `process_env` a CLI child runs with: [`BASE_CHILD_ENV`] plus
/// every variable starting with one of `prefixes`.
///
/// The child reads untrusted captured session text, so everything outside the
/// allowlist — ai-memory's own token, other providers' keys, arbitrary
/// operator secrets — is dropped.
pub(crate) fn allowlisted_env(
    process_env: &[(OsString, OsString)],
    prefixes: &[&str],
) -> Vec<(OsString, OsString)> {
    process_env
        .iter()
        .filter(|(name, _)| is_allowed(name, prefixes))
        .cloned()
        .collect()
}

fn is_allowed(name: &OsStr, prefixes: &[&str]) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    BASE_CHILD_ENV
        .iter()
        .any(|allowed| name.eq_ignore_ascii_case(allowed))
        || prefixes.iter().any(|prefix| {
            name.len() > prefix.len()
                && name.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
        })
}

/// A per-call directory, private to the server's user, removed on drop.
pub(crate) struct TempWorkspace {
    pub(crate) path: PathBuf,
}

impl TempWorkspace {
    /// Create `<root>/ai-memory-<name>-<uuid>`. `root` must be absolute: a
    /// relative one would put captured session text under the server's cwd.
    pub(crate) fn create(root: &Path, name: &str) -> LlmResult<Self> {
        if !root.is_absolute() {
            return Err(LlmError::NotConfigured(format!(
                "{name} workspace root must be an absolute path, got {}",
                root.display()
            )));
        }
        let path = root.join(format!("ai-memory-{name}-{}", Uuid::now_v7()));
        // The prompt is captured session text: keep the workspace private
        // to the server's user on a shared temp directory.
        #[cfg(unix)]
        let builder = {
            use std::os::unix::fs::DirBuilderExt as _;
            let mut builder = std::fs::DirBuilder::new();
            builder.mode(0o700);
            builder
        };
        #[cfg(not(unix))]
        let builder = std::fs::DirBuilder::new();
        builder.create(&path).map_err(|err| {
            LlmError::UnexpectedShape(format!("creating {name} workspace: {err}"))
        })?;
        Ok(Self { path })
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// The request's messages as one Markdown document, with the schema
/// instruction appended when `schema` is given. The system prompt is left to
/// the caller: one CLI takes it as a flag, another reads it from the document.
pub(crate) fn render_messages(request: &ChatRequest, schema: Option<&serde_json::Value>) -> String {
    let mut body = String::new();
    for message in &request.messages {
        let heading = match message.role {
            Role::User => "# User\n",
            Role::Assistant => "# Assistant\n",
        };
        body.push_str(heading);
        body.push_str(&message.content);
        body.push_str("\n\n");
    }
    if let Some(schema) = schema {
        body.push_str("# Output\nReturn one JSON value matching this schema and nothing else.\n");
        body.push_str(&schema.to_string());
        body.push('\n');
    }
    body
}

/// The JSON value in a CLI's answer: the whole text, a fenced block, or the
/// outermost `{…}`/`[…]` span inside surrounding prose.
pub(crate) fn parse_json_answer(text: &str, who: &str) -> LlmResult<serde_json::Value> {
    let stripped = strip_fence(text.trim());
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(stripped) {
        return Ok(value);
    }
    let start = stripped.find(['{', '[']);
    let end = stripped.rfind(['}', ']']);
    if let (Some(start), Some(end)) = (start, end)
        && end > start
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(&stripped[start..=end])
    {
        return Ok(value);
    }
    Err(LlmError::UnexpectedShape(format!(
        "{who} did not return JSON: {}",
        truncate_chars(stripped, 200)
    )))
}

fn strip_fence(text: &str) -> &str {
    let Some(rest) = text.strip_prefix("```") else {
        return text;
    };
    let rest = rest.trim_start_matches(|c: char| c.is_ascii_alphanumeric() || c == '-');
    let rest = rest.trim_start_matches(['\r', '\n']);
    rest.trim_end().trim_end_matches('`').trim_end()
}

pub(crate) fn truncate_chars(text: &str, max: usize) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if out.chars().count() >= max {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

async fn read_capped(
    mut reader: impl AsyncRead + Unpin,
    cap: usize,
    who: &str,
) -> LlmResult<Vec<u8>> {
    let mut buf = [0_u8; 8192];
    let mut out = Vec::new();
    loop {
        let n = reader
            .read(&mut buf)
            .await
            .map_err(|err| LlmError::UnexpectedShape(format!("reading {who}: {err}")))?;
        if n == 0 {
            break;
        }
        if out.len().saturating_add(n) > cap {
            return Err(LlmError::UnexpectedShape(format!(
                "{who} output exceeded the size cap"
            )));
        }
        out.extend_from_slice(&buf[..n]);
    }
    Ok(out)
}

/// What a finished child left behind.
pub(crate) struct CliOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

/// Spawn `command` (its argv, env and cwd already set), feed it `stdin`, and
/// collect both pipes under one `deadline`. The child is killed when the call
/// is dropped (a timeout or a cancelled future), so it never outlives it.
pub(crate) async fn run(
    command: &mut Command,
    stdin: Option<Vec<u8>>,
    deadline: Duration,
    who: &str,
) -> LlmResult<CliOutput> {
    command
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = spawn_retrying_busy(command).await.map_err(|err| {
        LlmError::NotConfigured(format!(
            "{who} ({}) failed to start: {err}",
            command.as_std().get_program().to_string_lossy()
        ))
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| LlmError::UnexpectedShape(format!("{who} stdout missing")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| LlmError::UnexpectedShape(format!("{who} stderr missing")))?;
    let input = child.stdin.take();

    timeout(deadline, async {
        // Every pipe moves at once: reading stdout to EOF first would leave a
        // chatty child blocked on a full stderr pipe until the deadline, and a
        // child that answers before reading all of its stdin would block on
        // ours. `try_join!` also stops at the first capped stream instead of
        // waiting on the others (the child is killed on drop).
        let feed = async {
            if let (Some(mut pipe), Some(bytes)) = (input, stdin) {
                // A child that exits without reading everything closes the
                // pipe; its exit status, not the broken pipe, is the answer.
                let _ = pipe.write_all(&bytes).await;
                drop(pipe);
            }
            Ok::<_, LlmError>(())
        };
        let ((), stdout, stderr) = tokio::try_join!(
            feed,
            read_capped(stdout, MAX_STDOUT_BYTES, who),
            read_capped(stderr, MAX_STDERR_BYTES, who)
        )?;
        let status = child
            .wait()
            .await
            .map_err(|err| LlmError::UnexpectedShape(format!("waiting for {who}: {err}")))?;
        Ok::<_, LlmError>(CliOutput {
            status,
            stdout,
            stderr,
        })
    })
    .await
    .map_err(|_| LlmError::Provider {
        status: 504,
        body: format!("{who} timed out"),
    })?
}

/// A non-zero exit as a provider error carrying the end of stderr.
pub(crate) fn exit_error(output: &CliOutput) -> LlmError {
    let code = output.status.code().unwrap_or(1);
    let body = String::from_utf8_lossy(&output.stderr);
    LlmError::Provider {
        status: u16::try_from(code).unwrap_or(1),
        body: truncate_chars(body.trim(), 500),
    }
}

/// Spawn, retrying briefly while the executable is busy (ETXTBSY): a file
/// still open for writing in another process — an agent binary being
/// replaced by its updater, or a just-written script whose descriptor a
/// concurrent fork inherited until its exec — cannot be executed yet.
async fn spawn_retrying_busy(command: &mut Command) -> std::io::Result<tokio::process::Child> {
    const ATTEMPTS: u32 = 5;
    let mut attempt = 1;
    loop {
        match command.spawn() {
            Err(err)
                if err.kind() == std::io::ErrorKind::ExecutableFileBusy && attempt < ATTEMPTS =>
            {
                attempt += 1;
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            result => return result,
        }
    }
}
