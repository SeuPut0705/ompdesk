//! Running a check on this computer when placement puts it here (design §5 policy 5), through the `ompdesk check`
//! machinery every session already uses: its heavy slot, its journal, its digest and reuse, its flaky record.
//!
//! - The hub keeps one checkout per repository (`<dir>/checkouts/<owner>__<name>`, never anyone's own), moves it to
//!   the commit under test (fetched by its sha, a forced detached checkout, untracked files removed; ignored ones such
//!   as `node_modules` stay, so the repo's setup is quick), runs the repo's `.ompdesk/worktree-setup` when it has one,
//!   then `ompdesk check [--release] -- <command>` there. A stable folder keeps the check's key the same from run to
//!   run, so a result on the same inputs is reused as `ompdesk check` reuses one for a session.
//! - One run at a time per repository: they share the checkout.
//! - The run's id comes from `ompdesk check`'s own line on stderr; the hub claims it at once, so the board shows the
//!   journal as the hub's run. The answer is read from the journal once the run ended.
//! - A run that never started (no git yet, a fetch that failed, a setup that failed) is an error the hub answers by
//!   running the check on a GitHub runner instead; a run that started answers with its own verdict.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::answer;
use super::contract::{
    Answer, AnswerVerdict, Counts, DeviceId, FailedTest, LocalRunAsk, Next, Note, NoteCode, Os,
    Timestamp,
};
use super::hub::Fut;
use super::poller::local::Journals;
use super::sources::LocalRun;
use crate::run::Runner;
use crate::server::Scope;

/// How long a fetch of the commit under test may take.
const FETCH_TIMEOUT_MS: u64 = 10 * 60 * 1000;
/// How long the repo's setup may take (an install from a cold cache).
const SETUP_TIMEOUT_MS: u64 = 20 * 60 * 1000;

#[derive(Clone, Debug)]
pub struct LocalFailure {
    pub name: String,
    pub first_error: Option<String>,
    pub known_flaky: bool,
}

#[derive(Clone, Debug)]
pub struct LocalResult {
    pub run: LocalRun,
    pub failed: Option<Vec<LocalFailure>>,
}
struct CheckoutGuard {
    lock: PathBuf,
    generation: String,
}

/// Runs a check on this computer. `started` hears the run's journal id as soon as it has one.
pub trait LocalRunner: Send + Sync {
    fn run<'a>(
        &'a self,
        ask: &'a LocalRunAsk,
        started: Box<dyn FnOnce(&str) + Send + 'a>,
        scope: Scope,
    ) -> Fut<'a, Result<LocalResult, String>>;
}

/// The run id in one of `ompdesk check`'s stderr lines: the run it starts (`run <id> (<runner>); …`) or the run of the
/// same check on the same inputs it follows instead (`run <id> of this check is already under way …`). The line that
/// names a run under way on other inputs before starting another names no run of this start.
pub fn run_id_of(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("ompdesk check: run ")?;
    let (id, after) = rest.split_once(' ')?;
    (after.starts_with('(') || after.contains("already under way")).then_some(id)
}

/// The hub's answer of a check `ompdesk check` ran on `device`: its verdict, its failed tests by name, the tests it
/// put in quarantine. A run that ended any other way than passed or failed (cancelled, killed, error) is unknown.
pub fn answer_of(
    run_id: &str,
    result: &LocalResult,
    device: &DeviceId,
    argv: &[String],
    _os: Os,
    now: Timestamp,
) -> Answer {
    let run = &result.run;
    let (verdict, next) = match run.state.as_str() {
        "passed" => (AnswerVerdict::Green, Next::Land),
        "failed" => (AnswerVerdict::Red, Next::Fix),
        _ => (AnswerVerdict::Unknown, Next::Wait),
    };
    let mut answer = answer::blank(run_id, verdict, now, next);
    answer.counts = Counts {
        passed: 0,
        failed: run.failed.len() as u32,
    };
    answer.failed = result
        .failed
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|failure| FailedTest {
            test: failure.name.clone(),
            first_error: failure.first_error.clone(),
            known_flaky: failure.known_flaky,
            history: "Test history is unavailable.".into(),
            record: None,
        })
        .collect();
    answer.counts.failed = answer.failed.len() as u32;
    if result.failed.is_none() && !run.failed.is_empty() {
        answer.verdict = AnswerVerdict::Unknown;
        answer.next = Next::Wait;
        answer.say(Note {
            error: Some("the local verdict did not retain per-test quarantine details".into()),
            ..Note::new(NoteCode::ResultsUnreadable)
        });
    }
    answer.say(Note {
        device: Some(device.clone()),
        job: Some(argv.join(" ")),
        ..Note::new(NoteCode::RanOn)
    });
    for name in &run.flaky {
        answer.say(Note {
            test: Some(name.clone()),
            ..Note::new(NoteCode::QuarantineEntered)
        });
    }
    if verdict == AnswerVerdict::Unknown {
        answer.say(Note {
            error: Some(format!(
                "the run ended {}: `ompdesk check status {}` shows it",
                run.state, run.id
            )),
            ..Note::new(NoteCode::ResultsUnreadable)
        });
    }
    answer
}

fn slug(repo: &str) -> String {
    repo.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// A hub that runs no check on its computer (a test's): every run placed here goes to GitHub instead.
pub struct Unavailable;

impl LocalRunner for Unavailable {
    fn run<'a>(
        &'a self,
        _ask: &'a LocalRunAsk,
        _started: Box<dyn FnOnce(&str) + Send + 'a>,
        _scope: Scope,
    ) -> Fut<'a, Result<LocalResult, String>> {
        Box::pin(async { Err("this hub runs no checks on its computer".to_owned()) })
    }
}

/// The real runner: git as main hands it over, the `ompdesk` binary beside the core, the journals it writes.
pub struct CheckRunner {
    /// How git runs now (and the environment the check runs with); none until main handed it over.
    pub runner: Box<dyn Fn() -> Option<Runner> + Send + Sync>,
    /// The hub's folder; the checkouts live in `<dir>/checkouts`.
    pub dir: Box<dyn Fn() -> PathBuf + Send + Sync>,
    /// The remote's URL of a repository (`owner/name`).
    pub url: Box<dyn Fn(&str) -> String + Send + Sync>,
    pub bin: PathBuf,
    pub journals: Arc<Journals>,
    /// One run at a time per repository.
    pub busy: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl CheckRunner {
    /// The runner of the hub `core`: its git, its folder, GitHub's URLs, the journals of this computer's store.
    pub fn of(core: std::sync::Weak<super::hub::Core>) -> Arc<dyn LocalRunner> {
        let Some(root) = super::poller::local::store_root(&|name| std::env::var(name).ok()) else {
            return Arc::new(Unavailable);
        };
        let dir = core.clone();
        Arc::new(CheckRunner {
            runner: Box::new(move || core.upgrade()?.git_runner()),
            dir: Box::new(move || {
                dir.upgrade().map_or_else(
                    || std::env::temp_dir().join("ompdesk-checks-closed"),
                    |core| core.work_dir(),
                )
            }),
            url: Box::new(super::queue::run::github_url),
            bin: super::poller::local::ompdesk_bin(),
            journals: Arc::new(Journals { root }),
            busy: Mutex::default(),
        })
    }

    fn lock_of(&self, repo: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut busy = self
            .busy
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Arc::clone(busy.entry(repo.to_owned()).or_default())
    }

    async fn checkout_lock(&self, path: &Path, scope: &Scope) -> Result<std::fs::File, String> {
        let parent = path.parent().ok_or("checkout has no parent")?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let lock_path = parent.join(format!(
            "{}.lock",
            path.file_name()
                .ok_or("checkout has no name")?
                .to_string_lossy()
        ));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)
            .map_err(|error| error.to_string())?;
        loop {
            if scope.cancelled() {
                return Err("cancelled".into());
            }
            match file.try_lock() {
                Ok(()) => return Ok(file),
                Err(std::fs::TryLockError::WouldBlock) => {}
                Err(error) => return Err(error.to_string()),
            }
            tokio::select! {
                () = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
                () = scope.on_cancel() => return Err("cancelled".into()),
            }
        }
    }

    async fn await_checkout_idle(&self, path: &Path, scope: &Scope) -> Result<(), String> {
        loop {
            if self.journals.active_in_checkout(path)?.is_empty() {
                return Ok(());
            }
            tokio::select! {
                () = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
                () = scope.on_cancel() => return Err("cancelled".into()),
            }
        }
    }

    /// The repository's checkout at `sha`, made the first time.
    async fn checkout(
        &self,
        path: &Path,
        runner: &Runner,
        scope: &Scope,
        repo: &str,
        sha: &str,
        guard: &CheckoutGuard,
    ) -> Result<(), String> {
        std::fs::create_dir_all(path).map_err(|error| format!("{}: {error}", path.display()))?;
        if !path.join(".git").exists() {
            self.git_step(
                path,
                runner,
                scope,
                guard,
                &["init", "-q"],
                runner.timeout_ms,
            )
            .await
            .map_err(|error| format!("git init: {error}"))?;
            self.git_step(
                path,
                runner,
                scope,
                guard,
                &["remote", "add", "origin", &(self.url)(repo)],
                runner.timeout_ms,
            )
            .await
            .map_err(|error| format!("git remote add: {error}"))?;
        }
        self.git_step(
            path,
            runner,
            scope,
            guard,
            &["fetch", "--no-tags", "-q", "origin", sha],
            FETCH_TIMEOUT_MS,
        )
        .await
        .map_err(|error| format!("fetching {sha} from {repo}: {error}"))?;
        self.git_step(
            path,
            runner,
            scope,
            guard,
            &["checkout", "-q", "--detach", "--force", sha],
            runner.timeout_ms,
        )
        .await
        .map_err(|error| format!("git checkout: {error}"))?;
        self.git_step(
            path,
            runner,
            scope,
            guard,
            &["clean", "-q", "-d", "--force"],
            runner.timeout_ms,
        )
        .await
        .map_err(|error| format!("git clean: {error}"))?;
        Ok(())
    }

    async fn git_step(
        &self,
        path: &Path,
        runner: &Runner,
        scope: &Scope,
        guard: &CheckoutGuard,
        args: &[&str],
        timeout: u64,
    ) -> Result<(), String> {
        let mut argv = vec![runner.bin.clone()];
        argv.extend(runner.args.iter().cloned());
        argv.extend(args.iter().map(|arg| (*arg).to_owned()));
        self.guarded_command(path, runner, scope, guard, None, &argv, timeout)
            .await
    }

    /// The repo's own setup of a fresh checkout (`.ompdesk/worktree-setup`, `.cmd` on Windows), when it has one.
    async fn setup(
        &self,
        path: &Path,
        runner: &Runner,
        scope: &Scope,
        sha: &str,
        guard: &CheckoutGuard,
    ) -> Result<(), String> {
        let script = path.join(".ompdesk").join(if cfg!(windows) {
            "worktree-setup.cmd"
        } else {
            "worktree-setup"
        });
        if !script.is_file() {
            return Ok(());
        }
        let mut argv = if cfg!(windows) {
            vec!["cmd".into(), "/c".into()]
        } else {
            vec!["sh".into()]
        };
        argv.push(script.to_string_lossy().into_owned());
        self.guarded_command(
            path,
            runner,
            scope,
            guard,
            Some(sha),
            &argv,
            SETUP_TIMEOUT_MS,
        )
        .await
    }

    async fn guarded_command(
        &self,
        path: &Path,
        runner: &Runner,
        scope: &Scope,
        guard: &CheckoutGuard,
        sha: Option<&str>,
        argv: &[String],
        timeout: u64,
    ) -> Result<(), String> {
        if scope.cancelled() {
            return Err("cancelled".into());
        }
        let mut command = Command::new(&self.bin);
        command
            .args(["check", "--checkout-setup"])
            .args(argv)
            .current_dir(path)
            .env_clear()
            .envs(&runner.env)
            .env(ompdesk_checks::check::CHECKOUT_LOCK_ENV, &guard.lock)
            .env(
                ompdesk_checks::check::CHECKOUT_GENERATION_ENV,
                &guard.generation,
            )
            .env(ompdesk_checks::check::CHECKOUT_GIT_ENV, &runner.bin)
            .env(
                ompdesk_checks::check::CHECKOUT_GIT_ARGS_ENV,
                serde_json::to_string(&runner.args).map_err(|error| error.to_string())?,
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if let Some(sha) = sha {
            command.env(ompdesk_checks::check::CHECKOUT_SHA_ENV, sha);
        } else {
            command.env_remove(ompdesk_checks::check::CHECKOUT_SHA_ENV);
        }
        hide_window(&mut command);
        // CoreProcess kills its POSIX group on death. The B-owning supervisor must survive
        // that kill long enough to observe stdin EOF and join its separate child group.
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let input = child.stdin.take().ok_or("setup supervisor has no stdin")?;
        let waited = child.wait_with_output();
        tokio::pin!(waited);
        let mut input = Some(input);
        let mut interrupted = None;
        let output = tokio::select! {
            result = &mut waited => result,
            () = scope.on_cancel() => {
                interrupted = Some("cancelled");
                drop(input.take());
                waited.await
            }
            () = tokio::time::sleep(std::time::Duration::from_millis(timeout)) => {
                interrupted = Some("the checkout command ran past its time");
                drop(input.take());
                waited.await
            }
        }
        .map_err(|error| error.to_string())?;
        if let Some(why) = interrupted {
            return Err(why.into());
        }
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let last = stderr.lines().rev().find(|line| !line.trim().is_empty());
        Err(format!(
            "the checkout command failed ({}){}",
            output.status,
            last.map(|line| format!(": {line}")).unwrap_or_default()
        ))
    }

    async fn cancel(&self, id: &str, runner: &Runner) {
        let mut command = Command::new(&self.bin);
        command
            .args(["check", "cancel", id])
            .env_clear()
            .envs(&runner.env)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_window(&mut command);
        if let Ok(mut child) = command.spawn() {
            let _ = child.wait().await;
        }
    }
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    command.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

impl LocalRunner for CheckRunner {
    fn run<'a>(
        &'a self,
        ask: &'a LocalRunAsk,
        started: Box<dyn FnOnce(&str) + Send + 'a>,
        scope: Scope,
    ) -> Fut<'a, Result<LocalResult, String>> {
        Box::pin(async move {
            let runner = (self.runner)().ok_or("git is not available to the checks hub yet")?;
            let lock = self.lock_of(&ask.repo);
            let _turn = tokio::select! {
                turn = lock.lock() => turn,
                () = scope.on_cancel() => return Err("cancelled".into()),
            };
            let checkout = (self.dir)().join("checkouts").join(slug(&ask.repo));
            let _checkout_lock = self.checkout_lock(&checkout, &scope).await?;
            self.await_checkout_idle(&checkout, &scope).await?;
            let runner_checkout = checkout.with_file_name(format!("{}.runner", slug(&ask.repo)));
            let runtime_lock_path = runner_checkout.with_extension("runner.lock");
            let first_use = !runtime_lock_path.exists();
            let runtime_lock = self.checkout_lock(&runner_checkout, &scope).await?;
            let mut generation_path = runtime_lock_path.as_os_str().to_owned();
            generation_path.push(".generation");
            let generation_path = PathBuf::from(generation_path);
            let previous = match std::fs::read_to_string(&generation_path) {
                Ok(value) => value
                    .parse::<u64>()
                    .map_err(|error| format!("checkout generation: {error}"))?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && first_use => 0,
                Err(error) => return Err(error.to_string()),
            };
            let generation = previous
                .checked_add(1)
                .ok_or("checkout generation exhausted")?
                .to_string();
            let written = crate::disk::tree::write_atomic_if(
                &generation_path,
                generation.as_bytes(),
                Some(0o600),
                0o700,
                &|| true,
            )
            .map_err(|fault| fault.message)?;
            if !written {
                return Err("checkout generation was not written".into());
            }
            let guard = CheckoutGuard {
                lock: runtime_lock_path,
                generation,
            };
            drop(runtime_lock);
            self.checkout(&checkout, &runner, &scope, &ask.repo, &ask.sha, &guard)
                .await?;
            self.setup(&checkout, &runner, &scope, &ask.sha, &guard)
                .await?;
            if scope.cancelled() {
                return Err("cancelled".into());
            }
            let path = checkout;
            let mut command = Command::new(&self.bin);
            command.arg("check");
            if ask.release {
                command.arg("--release");
            }
            command
                .arg("--")
                .args(&ask.argv)
                .current_dir(&path)
                .env_clear()
                .envs(&runner.env)
                .env(ompdesk_checks::check::CHECKOUT_LOCK_ENV, &guard.lock)
                .env(
                    ompdesk_checks::check::CHECKOUT_GENERATION_ENV,
                    &guard.generation,
                )
                .env(ompdesk_checks::check::CHECKOUT_SHA_ENV, &ask.sha)
                .env(ompdesk_checks::check::CHECKOUT_GIT_ENV, &runner.bin)
                .env(
                    ompdesk_checks::check::CHECKOUT_GIT_ARGS_ENV,
                    serde_json::to_string(&runner.args).map_err(|error| error.to_string())?,
                )
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            hide_window(&mut command);
            let mut child = command
                .spawn()
                .map_err(|error| format!("{}: {error}", self.bin.display()))?;
            let stderr = child.stderr.take().ok_or("ompdesk check gave no stderr")?;
            let mut lines = BufReader::new(stderr).lines();
            let mut started = Some(started);
            let mut id = None;
            let mut cancelled = scope.cancelled();
            let mut sent_cancel = false;
            loop {
                if cancelled
                    && !sent_cancel
                    && let Some(id) = id.as_deref()
                {
                    self.cancel(id, &runner).await;
                    sent_cancel = true;
                }
                tokio::select! {
                    line = lines.next_line() => match line {
                        Ok(Some(line)) => {
                            if id.is_none() && let Some(found) = run_id_of(&line) {
                                id = Some(found.to_owned());
                                if let Some(started) = started.take() {
                                    started(found);
                                }
                            }
                        }
                        _ => break,
                    },
                    () = scope.on_cancel(), if !cancelled => cancelled = true,
                }
            }
            let status = if cancelled || scope.cancelled() {
                if !sent_cancel && let Some(id) = id.as_deref() {
                    self.cancel(id, &runner).await;
                }
                child.wait().await
            } else {
                tokio::select! {
                    result = child.wait() => result,
                    () = scope.on_cancel() => {
                        if !sent_cancel && let Some(id) = id.as_deref() {
                            self.cancel(id, &runner).await;
                        }
                        child.wait().await
                    }
                }
            }
            .map_err(|error| error.to_string())?;
            // The foreground attach may return before the detached runner releases its alive lock.
            // Do not hand this checkout to another run until that runner's cleanup is over.
            self.await_checkout_idle(&path, &Scope::detached()).await?;
            if scope.cancelled() {
                return Err("cancelled".into());
            }
            let id = id
                .ok_or_else(|| format!("ompdesk check ended ({status}) before it named its run"))?;
            let journals = Arc::clone(&self.journals);
            let found = id.clone();
            tokio::task::spawn_blocking(move || journals.result_blocking(&found))
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("the journal of run {id} could not be read"))
        })
    }
}

#[cfg(test)]
#[path = "local_run_tests.rs"]
mod tests;
