//! Autopilot's check of a land candidate (was `src/main/autopilot-land-check.ts`): the commit that merges the default
//! branch, which moved on, into a green cycle's commit. A clean textual merge is not a green one (the default branch's
//! commits and the cycle's can break each other), so the exact candidate commit is checked out on its own (a detached
//! `git worktree add` in a temporary folder, prepared as every new worktree is: `.worktreeinclude` and the repository's
//! setup hook), the cycle's own check command runs there under the supervisor, and the folder is removed again whatever
//! happened. The command is the one the cycle's tool calls ran and passed (it passed the bridge's guard there); the run's
//! worktree path in it points at the temporary checkout instead. Nothing here touches the run's worktree or the user's
//! checkout.
//!
//! The files are exactly the candidate's; HEAD is then moved (`reset --soft`) to the default branch's tip it merges, so
//! the run's whole change shows as uncommitted. A check that only looks at what changed against HEAD (this repository's
//! `check:changed`) would find nothing on a clean checkout of the candidate and pass without checking anything; this way
//! it checks the run's change on top of the default branch as it is now.
//!
//! What stays main's, asked by port: the checkout's preparation (`prepareWorktree`: the seed and the setup hook, which
//! `local/git/worktree-seed.ts` runs under the supervisor) and the shell and environment the check runs in (`landShell`:
//! the login shell's PATH and exports under the app's, Git Bash on Windows, and where the supervisor binary is).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

use super::host::Backend;
use crate::fs::disk;
use crate::fs::error::Codes;
use crate::git::read::blocking;
use crate::git::run::Git;
use crate::machine::{CommandShell, ShellContext};

use crate::run::Opts;
use crate::server::{Fault, Scope};

/// A check that runs this long is stopped and counts as failed (the candidate is not landed).
pub const LAND_CHECK_TIMEOUT_MS: u64 = 30 * 60_000;
/// After the timeout asked the supervisor to stop the check, how long it has before the check is killed and given up.
pub const STOP_GRACE_MS: u64 = 30_000;
const OUTPUT_TAIL: usize = 2_000;
const ERROR_LINES: usize = 12;
/// `SUPERVISOR_STOPPED_CODE` (`supervise.rs`): the exit status after a stop ended the command.
const SUPERVISOR_STOPPED_CODE: i32 = 130;

// ---- JavaScript string measures ---------------------------------------------------------------------------------

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn from_units(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `text.slice(-count)`: the last `count` UTF-16 units (a pair cut in half reads U+FFFD).
pub fn tail_units(text: &str, count: usize) -> String {
    let all = units(text);
    from_units(&all[all.len().saturating_sub(count)..])
}

fn head_units(text: &str, count: usize) -> String {
    let all = units(text);
    from_units(&all[..all.len().min(count)])
}

// ---- the excerpt ----------------------------------------------------------------------------------------------

/// Terminal color and cursor codes (`ESC [ … letter`): runners color their errors under FORCE_COLOR.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut at = 0;
    while at < chars.len() {
        if chars[at] == '\u{1b}' && chars.get(at + 1) == Some(&'[') {
            let mut end = at + 2;
            while end < chars.len()
                && (chars[end].is_ascii_digit() || chars[end] == ';' || chars[end] == '?')
            {
                end += 1;
            }
            if chars.get(end).is_some_and(char::is_ascii_alphabetic) {
                at = end + 1;
                continue;
            }
        }
        out.push(chars[at]);
        at += 1;
    }
    out
}

/// A line that starts an error report: JavaScript's error names, `error:`/`Error:` lines, a Python traceback
/// (`^\s*(?:[A-Z][A-Za-z]*Error\b|Error:|error(?:\[[^\]]*\])?:|Traceback)`).
fn is_error_line(line: &str) -> bool {
    let line = line.trim_start_matches(crate::fs::order::is_js_space);
    let run: String = line.chars().take_while(char::is_ascii_alphabetic).collect();
    let after = line[run.len()..].chars().next();
    let named = run.len() >= 6
        && run.starts_with(|c: char| c.is_ascii_uppercase())
        && run.ends_with("Error")
        && !after.is_some_and(|c| c.is_ascii_digit() || c == '_');
    if named || line.starts_with("Error:") || line.starts_with("Traceback") {
        return true;
    }
    let Some(rest) = line.strip_prefix("error") else {
        return false;
    };
    if rest.starts_with(':') {
        return true;
    }
    rest.strip_prefix('[')
        .and_then(|inner| inner.find(']').map(|close| &inner[close + 1..]))
        .is_some_and(|after_bracket| after_bracket.starts_with(':'))
}

/// What a refused land shows of the check: the first error and the lines under it, then the output's end. A runner that
/// lists every failing file after its errors (vitest groups files that failed the same way) filled the whole tail with
/// file names, and the reason was gone. Color codes go first: vitest wraps an error's name in them, so a colored line
/// never started with the name, and a note has no terminal to draw them.
pub fn check_excerpt(raw: &str) -> String {
    let output = strip_ansi(raw);
    let tail = tail_units(&output, OUTPUT_TAIL);
    let lines: Vec<&str> = output.split('\n').collect();
    let Some(first) = lines.iter().position(|line| is_error_line(line)) else {
        return tail;
    };
    let head = head_units(
        &lines[first..lines.len().min(first + ERROR_LINES)].join("\n"),
        OUTPUT_TAIL / 2,
    );
    if tail.contains(&head) {
        return tail;
    }
    let room = OUTPUT_TAIL.saturating_sub(units(&head).len() + 3);
    format!("{head}\n…\n{}", tail_units(&output, room))
}

// ---- pointing the command at the temporary checkout ------------------------------------------------------------

/// `path.win32.normalize`.
fn win32_normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let s = path.replace('/', "\\");
    let (root, rest, absolute): (String, &str, bool) = if let Some(unc) = s.strip_prefix("\\\\") {
        let mut parts = unc.splitn(3, '\\');
        match (parts.next(), parts.next()) {
            (Some(server), Some(share)) if !server.is_empty() && !share.is_empty() => {
                let used = server.len() + 1 + share.len();
                (
                    format!("\\\\{server}\\{share}\\"),
                    unc.get(used..).unwrap_or(""),
                    true,
                )
            }
            _ => ("\\".into(), &s[1..], true),
        }
    } else if s.as_bytes().get(1) == Some(&b':') && s.as_bytes()[0].is_ascii_alphabetic() {
        let drive = &s[..2];
        match s.get(2..3) {
            Some("\\") => (format!("{drive}\\"), &s[3..], true),
            _ => (drive.to_owned(), &s[2..], false),
        }
    } else if let Some(rest) = s.strip_prefix('\\') {
        ("\\".into(), rest, true)
    } else {
        (String::new(), &s[..], false)
    };
    let mut kept: Vec<&str> = Vec::new();
    for part in rest
        .split('\\')
        .filter(|part| !part.is_empty() && *part != ".")
    {
        if part == ".." {
            match kept.last() {
                Some(last) if *last != ".." => {
                    kept.pop();
                }
                _ if !absolute => kept.push(".."),
                _ => {}
            }
        } else {
            kept.push(part);
        }
    }
    let mut body = kept.join("\\");
    if !body.is_empty() && rest.ends_with('\\') {
        body.push('\\');
    }
    if body.is_empty() && !absolute {
        body = ".".into();
    }
    format!("{root}{body}")
}

/// How a shell command can name a Windows path: escaped, as is, with forward slashes, as Git Bash's `/c/…`.
fn windows_spellings(path: &str) -> Vec<String> {
    let native = win32_normalize(path);
    let forms = |head: &str, rest: &str| {
        vec![
            format!("{head}{}", rest.replace('\\', "\\\\")),
            format!("{head}{rest}"),
            format!("{head}{}", rest.replace('\\', "/")),
        ]
    };
    let bytes = native.as_bytes();
    if bytes.len() < 2 || bytes[1] != b':' || !bytes[0].is_ascii_alphabetic() {
        return forms("", &native);
    }
    let letter = &native[..1];
    let rest = &native[2..];
    let msys = rest.replace('\\', "/");
    [letter.to_uppercase(), letter.to_lowercase()]
        .into_iter()
        .flat_map(|l| {
            let mut all = forms(&format!("{l}:"), rest);
            all.push(format!("/{l}{msys}"));
            all
        })
        .collect()
}

/// The cycle's command with the run's worktree path pointed at the temporary checkout, written the way the command wrote
/// it. On Windows the agent's bash (Git Bash) reads an unquoted `C:\a\b` as `C:ab`, so a command that passed there names
/// the worktree as `C:/a/b`, `/c/a/b`, `C:\\a\\b` or a quoted `C:\a\b`, whatever spelling the run's root has.
pub fn point_command_at(command: &str, root: &str, tree: &str, platform: &str) -> String {
    if platform != "win32" {
        return command.replace(root, tree);
    }
    let targets = windows_spellings(tree);
    windows_spellings(root)
        .iter()
        .enumerate()
        .fold(command.to_owned(), |text, (at, spelling)| {
            text.replace(
                spelling.as_str(),
                targets.get(at).map_or(tree, String::as_str),
            )
        })
}

/// `process.platform` as the command's author spelled it.
pub fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

// ---- the check ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    /// The run's worktree: the repository the candidate lives in, and the path the command may name.
    pub root: String,
    /// The main checkout (where `.worktreeinclude` copies from).
    pub primary: String,
    /// The candidate commit, checked out exactly.
    pub sha: String,
    /// The default branch tip the candidate merges: HEAD in the temporary checkout, so the run's change is uncommitted.
    #[serde(default)]
    pub base: Option<String>,
    pub command: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LandCheck {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
    /// The end of what the setup hook (when it failed) and the command printed.
    pub tail: String,
}

struct Outcome {
    ok: bool,
    exit_code: Option<i32>,
    timed_out: bool,
    tail: String,
}

impl Outcome {
    fn failed(tail: String) -> Outcome {
        Outcome {
            ok: false,
            exit_code: None,
            timed_out: false,
            tail,
        }
    }
}

/// What main answers `prepareWorktree` with (`WorktreeSetupReport` is all this side reads).
#[derive(Deserialize)]
pub struct Prepared {
    #[serde(default)]
    pub setup: Option<Setup>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub script: String,
    pub output_tail: String,
}

/// The shell and environment the check runs in, and the supervisor that holds it (`landShell`).
#[derive(Clone, Deserialize, Serialize)]
pub struct Shell {
    env: BTreeMap<String, String>,
    file: String,
    args: Vec<String>,
    supervisor: String,
}

impl Shell {
    /// Machine selects the executable and inherited/login environment; this boundary only applies its command syntax.
    pub fn command(command: String, context: ShellContext) -> Result<Self, Fault> {
        let ShellContext {
            env,
            shell,
            supervisor,
        } = context;
        let path = |path: &std::path::Path| {
            path.to_str().map(str::to_owned).ok_or_else(|| {
                Fault::new(
                    "invalid_path",
                    "The land check executable path is not UTF-8",
                )
            })
        };
        let (file, args) = match shell {
            CommandShell::Bash(file) => (
                file,
                vec!["-o".into(), "pipefail".into(), "-c".into(), command],
            ),
            CommandShell::WindowsCmd(file) => {
                (file, vec!["/d".into(), "/s".into(), "/c".into(), command])
            }
            CommandShell::PosixSh(file) => (file, vec!["-c".into(), command]),
        };
        Ok(Self {
            env,
            file: path(&file)?,
            args,
            supervisor: path(&supervisor)?,
        })
    }
}

#[derive(Serialize)]
struct SupervisorSpec<'a> {
    file: &'a str,
    args: &'a [String],
    shell: bool,
}

/// The temporary folder of one check: removed when dropped, also when the step that holds it is stopped and its future
/// dropped (the git worktree entry it leaves is pruned by the next check's `worktree prune`).
struct Scratch(PathBuf);

impl Scratch {
    async fn new() -> Result<Scratch, Fault> {
        blocking(|| disk::make_temp_dir("ompdesk-land-check-"))
            .await?
            .map(Scratch)
            .map_err(|error| error.fault(Codes::None))
    }

    fn path(&self, name: &str) -> String {
        self.0.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn collect(
    mut pipe: impl AsyncRead + Unpin + Send + 'static,
    into: Arc<Mutex<Vec<u8>>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut chunk = vec![0; 16 * 1024];
        loop {
            match pipe.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => into
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .extend_from_slice(&chunk[..read]),
            }
        }
    })
}

/// Runs `command` in `cwd` under the supervisor, as `run` of the TypeScript did: past `timeout` (or once `scope` is
/// cancelled: the step that asked was stopped) the supervisor's stdin closes (it ends the check's tree), and a check still
/// running `stop_grace` later is killed and given up. The run is a task of its own that holds `scope` and `hold` until the
/// supervisor exited, so a step aborted meanwhile still ends the check, and its folder goes only after it.
async fn run_command(
    shell: &Shell,
    cwd: &str,
    timeout: Duration,
    stop_grace: Duration,
    scope: Scope,
    hold: Option<Arc<Scratch>>,
) -> Outcome {
    let (shell, cwd) = (shell.clone(), cwd.to_owned());
    tokio::spawn(async move {
        let outcome = supervised(&shell, &cwd, timeout, stop_grace, &scope).await;
        drop(hold);
        outcome
    })
    .await
    .unwrap_or_else(|error| Outcome::failed(error.to_string()))
}

async fn supervised(
    shell: &Shell,
    cwd: &str,
    timeout: Duration,
    stop_grace: Duration,
    scope: &Scope,
) -> Outcome {
    let spec = SupervisorSpec {
        file: &shell.file,
        args: &shell.args,
        shell: false,
    };
    let mut command = Command::new(&shell.supervisor);
    command
        .arg("--supervise")
        .env_clear()
        .envs(&shell.env)
        .env(
            "OMPDESK_SETUP_SPEC",
            serde_json::to_string(&spec).unwrap_or_default(),
        )
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return finish(&[], Some(&error.to_string()), None, false),
    };
    let output = Arc::new(Mutex::new(Vec::new()));
    let readers = [
        child
            .stdout
            .take()
            .map(|pipe| collect(pipe, output.clone())),
        child
            .stderr
            .take()
            .map(|pipe| collect(pipe, output.clone())),
    ];
    let mut stdin = child.stdin.take();
    let read = |output: &Arc<Mutex<Vec<u8>>>| {
        output
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    };
    let exited = tokio::select! {
        status = child.wait() => Some(status),
        () = tokio::time::sleep(timeout) => None,
        () = scope.on_cancel() => None,
    };
    let (code, timed_out, error) = match exited {
        Some(status) => (status.ok().and_then(|status| status.code()), false, None),
        None => {
            // The supervisor ends the check's tree when its stdin closes.
            drop(stdin.take());
            match tokio::time::timeout(stop_grace, child.wait()).await {
                Ok(status) => (status.ok().and_then(|status| status.code()), true, None),
                Err(_) => {
                    // A supervisor that does not stop the check (or never reports its end) must not hold the land.
                    let _ = child.start_kill();
                    (
                        None,
                        true,
                        Some("the check did not stop when asked".to_owned()),
                    )
                }
            }
        }
    };
    for reader in readers.into_iter().flatten() {
        // The pipes close with the supervisor; a descendant that holds one open does not keep the land waiting.
        let _ = tokio::time::timeout(Duration::from_secs(1), reader).await;
    }
    finish(&read(&output), error.as_deref(), code, timed_out)
}

fn finish(output: &[u8], error: Option<&str>, code: Option<i32>, timed_out: bool) -> Outcome {
    let mut text = String::from_utf8_lossy(output).into_owned();
    if let Some(error) = error {
        text.push_str(error);
        text.push('\n');
    }
    // A stopped check's own exit code is never taken as a pass.
    let exit_code = if timed_out || code == Some(SUPERVISOR_STOPPED_CODE) {
        None
    } else {
        code
    };
    Outcome {
        ok: !timed_out && exit_code == Some(0),
        exit_code,
        timed_out,
        tail: check_excerpt(&text),
    }
}

/// The git calls and the hook around the run; `None` is a check that failed before it ran.
async fn prepare(
    git: &Git,
    port: &Backend,
    input: &Input,
    scratch: &Scratch,
) -> Result<Result<(String, String), Outcome>, Fault> {
    let tree = scratch.path("tree");
    // No hook of the repository runs on the way in (a post-checkout hook would run code before the check does).
    let hooks = format!("core.hooksPath={}", scratch.path("no-hooks"));
    let slow = |ms: u64| Opts {
        timeout_ms: Some(ms),
        ..Opts::default()
    };
    let added = git
        .run(
            &input.root,
            &[
                "-c", &hooks, "worktree", "add", "--detach", "-q", &tree, &input.sha,
            ],
            slow(120_000),
        )
        .await?;
    if added.code != 0 {
        return Ok(Err(Outcome::failed(tail_units(&added.stderr, OUTPUT_TAIL))));
    }
    let prepared = port.prepare_worktree(&input.primary, &tree).await?;
    if let Some(setup) = prepared.setup.filter(|setup| !setup.ok) {
        return Ok(Err(Outcome {
            ok: false,
            exit_code: setup.exit_code,
            timed_out: setup.timed_out,
            tail: tail_units(
                &format!(
                    "worktree setup ({}) failed:\n{}",
                    setup.script, setup.output_tail
                ),
                OUTPUT_TAIL,
            ),
        }));
    }
    if let Some(base) = &input.base {
        let reset = git
            .run(&tree, &["reset", "-q", "--soft", base], slow(60_000))
            .await?;
        if reset.code != 0 {
            return Ok(Err(Outcome::failed(tail_units(&reset.stderr, OUTPUT_TAIL))));
        }
    }
    let command = point_command_at(&input.command, &input.root, &tree, platform());
    Ok(Ok((tree, command)))
}

/// Check `sha` out on its own, prepare it, run `command` there, and remove the checkout again. Never fails: a check
/// that could not run is a failed one with the reason in its tail.
pub async fn check_candidate(
    git: &Git,
    port: &Backend,
    input: &Input,
    stop_grace: Duration,
    scope: &Scope,
) -> LandCheck {
    let started = Instant::now();
    let finished = |outcome: Outcome| LandCheck {
        ok: outcome.ok,
        exit_code: outcome.exit_code,
        timed_out: outcome.timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
        tail: outcome.tail,
    };
    let scratch = match Scratch::new().await {
        Ok(scratch) => Arc::new(scratch),
        Err(fault) => return finished(Outcome::failed(fault.message)),
    };
    let outcome = async {
        let (tree, command) = match prepare(git, port, input, &scratch).await? {
            Ok(prepared) => prepared,
            Err(failed) => return Ok::<Outcome, Fault>(failed),
        };
        let shell = port.land_shell(command).await?;
        let timeout = Duration::from_millis(input.timeout_ms.unwrap_or(LAND_CHECK_TIMEOUT_MS));
        Ok(run_command(
            &shell,
            &tree,
            timeout,
            stop_grace,
            scope.clone(),
            Some(scratch.clone()),
        )
        .await)
    }
    .await
    .unwrap_or_else(|fault| Outcome::failed(fault.message));
    let tree = scratch.path("tree");
    let slow = |ms: u64| Opts {
        timeout_ms: Some(ms),
        ..Opts::default()
    };
    let _ = git
        .run(
            &input.root,
            &["worktree", "remove", "--force", "--force", &tree],
            slow(120_000),
        )
        .await;
    drop(scratch);
    let _ = git
        .run(&input.root, &["worktree", "prune"], slow(60_000))
        .await;
    finished(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn captured() -> Value {
        serde_json::from_str(include_str!("captured-land-check.json")).unwrap()
    }

    #[test]
    fn excerpts_match_the_typescript() {
        for case in captured()["excerpt"].as_array().unwrap() {
            let out = check_excerpt(case["input"].as_str().unwrap());
            assert_eq!(out, case["out"].as_str().unwrap(), "{}", case["input"]);
        }
    }

    #[test]
    fn pointed_commands_match_the_typescript() {
        for case in captured()["point"].as_array().unwrap() {
            let out = point_command_at(
                case["command"].as_str().unwrap(),
                case["root"].as_str().unwrap(),
                case["tree"].as_str().unwrap(),
                case["platform"].as_str().unwrap(),
            );
            assert_eq!(out, case["out"].as_str().unwrap(), "{case}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_native_shell_keeps_machine_exports_and_does_not_hide_a_failed_pipe() {
        let shell = Shell::command(
            "printf '%s' \"$AUTOPILOT_TEST_EXPORT\"; false | /usr/bin/true".into(),
            ShellContext {
                env: BTreeMap::from([("AUTOPILOT_TEST_EXPORT".into(), "from-login-shell".into())]),
                shell: CommandShell::Bash("/bin/bash".into()),
                supervisor: "/unused-supervisor".into(),
            },
        )
        .unwrap();
        let output = Command::new(&shell.file)
            .args(&shell.args)
            .env_clear()
            .envs(&shell.env)
            .output()
            .await
            .unwrap();
        assert_eq!(output.stdout, b"from-login-shell");
        assert!(!output.status.success());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_posix_fallback_runs_without_bash_only_options() {
        let shell = Shell::command(
            "printf '%s' \"$AUTOPILOT_TEST_EXPORT\"; exit 7".into(),
            ShellContext {
                env: BTreeMap::from([("AUTOPILOT_TEST_EXPORT".into(), "from-posix-shell".into())]),
                shell: CommandShell::PosixSh("/bin/sh".into()),
                supervisor: "/unused-supervisor".into(),
            },
        )
        .unwrap();
        assert_eq!(shell.args[0], "-c");
        assert_eq!(shell.args.len(), 2);
        let output = Command::new(&shell.file)
            .args(&shell.args)
            .env_clear()
            .envs(&shell.env)
            .output()
            .await
            .unwrap();
        assert_eq!(
            output.stdout,
            b"from-posix-shell",
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.status.code(), Some(7));
    }

    #[test]
    fn a_comspec_fallback_keeps_windows_command_arguments() {
        let command = "echo %AUTOPILOT_TEST_EXPORT% & exit /b 7";
        let shell = Shell::command(
            command.into(),
            ShellContext {
                env: BTreeMap::from([("AUTOPILOT_TEST_EXPORT".into(), "from-comspec".into())]),
                shell: CommandShell::WindowsCmd(r"C:\Windows\System32\cmd.exe".into()),
                supervisor: "/unused-supervisor".into(),
            },
        )
        .unwrap();
        assert_eq!(shell.args, ["/d", "/s", "/c", command]);
        assert_eq!(shell.file, r"C:\Windows\System32\cmd.exe");
        #[cfg(windows)]
        {
            let output = std::process::Command::new(&shell.file)
                .args(&shell.args)
                .env_clear()
                .envs(&shell.env)
                .output()
                .unwrap();
            assert_eq!(
                String::from_utf8_lossy(&output.stdout).trim(),
                "from-comspec"
            );
            assert_eq!(output.status.code(), Some(7));
        }
    }

    #[test]
    fn a_run_stopped_at_its_timeout_reports_timed_out_never_a_pass() {
        let out = finish(b"partial\n", None, Some(0), true);
        assert!(!out.ok && out.timed_out && out.exit_code.is_none());
        let stopped = finish(b"", None, Some(SUPERVISOR_STOPPED_CODE), false);
        assert!(!stopped.ok && stopped.exit_code.is_none());
        let passed = finish(b"fine", None, Some(0), false);
        assert!(passed.ok && passed.exit_code == Some(0) && passed.tail == "fine");
    }

    /// A cancelled check is ended (the supervisor's stdin closes) and the run returns only once it exited.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancelled_check_has_ended_when_its_run_returns() {
        use std::os::unix::fs::PermissionsExt;
        let base =
            std::env::temp_dir().join(format!("ompdesk-core-land-stop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let (up, exited) = (base.join("up"), base.join("exited"));
        // The stand-in supervisor ends when its stdin closes, and says so.
        let supervisor = base.join("supervisor");
        std::fs::write(
            &supervisor,
            format!(
                "#!/bin/sh\n: > \"{}\"\nwhile read -r _; do :; done\nsleep 0.2\necho ended > \"{}\"\n",
                up.display(),
                exited.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&supervisor, std::fs::Permissions::from_mode(0o755)).unwrap();
        let shell = Shell {
            env: BTreeMap::new(),
            file: "unused".into(),
            args: Vec::new(),
            supervisor: supervisor.to_string_lossy().into_owned(),
        };
        let scope = Scope::detached();
        let hold = Arc::new(Scratch(base.join("held")));
        let (outcome, ()) = tokio::join!(
            run_command(
                &shell,
                "/",
                Duration::from_secs(60),
                Duration::from_secs(5),
                scope.clone(),
                Some(hold),
            ),
            async {
                while !up.exists() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                scope.cancel();
            }
        );
        assert!(outcome.timed_out && !outcome.ok);
        assert!(exited.exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
