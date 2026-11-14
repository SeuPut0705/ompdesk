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
    TestRecord, TestState, Timestamp,
};
use super::hub::Fut;
use super::poller::local::Journals;
use super::sources::LocalRun;
use crate::git::run::Git;
use crate::run::{Opts, Runner};
use crate::server::Scope;

/// How long a fetch of the commit under test may take.
const FETCH_TIMEOUT_MS: u64 = 10 * 60 * 1000;
/// How long the repo's setup may take (an install from a cold cache).
const SETUP_TIMEOUT_MS: u64 = 20 * 60 * 1000;

/// Runs a check on this computer. `started` hears the run's journal id as soon as it has one.
pub trait LocalRunner: Send + Sync {
    fn run<'a>(
        &'a self,
        ask: &'a LocalRunAsk,
        started: Box<dyn FnOnce(&str) + Send + 'a>,
        scope: Scope,
    ) -> Fut<'a, Result<LocalRun, String>>;
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
    run: &LocalRun,
    device: &DeviceId,
    argv: &[String],
    os: Os,
    now: Timestamp,
) -> Answer {
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
    // What the hub knows of each failed test is this run: one failure in one run.
    let record = TestRecord {
        os,
        fails_7d: 1,
        runs_7d: 1,
        state: TestState::Active,
        clean_runs: 0,
        clear_after: ompdesk_checks::flaky::CLEAR_AFTER,
    };
    answer.failed = run
        .failed
        .iter()
        .map(|name| FailedTest {
            test: name.clone(),
            first_error: String::new(),
            known_flaky: false,
            history: record.english(),
            record: record.clone(),
        })
        .collect();
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
    ) -> Fut<'a, Result<LocalRun, String>> {
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

    /// The repository's checkout at `sha`, made the first time.
    async fn checkout(&self, git: &Git, repo: &str, sha: &str) -> Result<PathBuf, String> {
        let checkouts = (self.dir)().join("checkouts");
        let path = checkouts.join(slug(repo));
        let text = path.to_string_lossy().into_owned();
        let fail = |what: &str, error: crate::server::Fault| format!("{what}: {}", error.message);
        if !path.join(".git").exists() {
            std::fs::create_dir_all(&path).map_err(|error| format!("{text}: {error}"))?;
            git.text(&text, &["init", "-q"])
                .await
                .map_err(|error| fail("git init", error))?;
            git.text(&text, &["remote", "add", "origin", &(self.url)(repo)])
                .await
                .map_err(|error| fail("git remote add", error))?;
        }
        let fetch = Opts {
            timeout_ms: Some(FETCH_TIMEOUT_MS),
            ..Opts::default()
        };
        git.text_with(&text, &["fetch", "--no-tags", "-q", "origin", sha], fetch)
            .await
            .map_err(|error| fail(&format!("fetching {sha} from {repo}"), error))?;
        git.text(&text, &["checkout", "-q", "--detach", "--force", sha])
            .await
            .map_err(|error| fail("git checkout", error))?;
        git.text(&text, &["clean", "-q", "-d", "--force"])
            .await
            .map_err(|error| fail("git clean", error))?;
        Ok(path)
    }

    /// The repo's own setup of a fresh checkout (`.ompdesk/worktree-setup`, `.cmd` on Windows), when it has one.
    async fn setup(&self, path: &Path, runner: &Runner, scope: &Scope) -> Result<(), String> {
        let script = path.join(".ompdesk").join(if cfg!(windows) {
            "worktree-setup.cmd"
        } else {
            "worktree-setup"
        });
        if !script.is_file() {
            return Ok(());
        }
        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.arg("/c").arg(&script);
            command
        } else {
            let mut command = Command::new("sh");
            command.arg(&script);
            command
        };
        command
            .current_dir(path)
            .env_clear()
            .envs(&runner.env)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        hide_window(&mut command);
        let child = command
            .spawn()
            .map_err(|error| format!("{}: {error}", script.display()))?;
        let waited = tokio::time::timeout(
            std::time::Duration::from_millis(SETUP_TIMEOUT_MS),
            child.wait_with_output(),
        );
        let output = tokio::select! {
            output = waited => output.map_err(|_| "the repo's setup ran past its time".to_owned())?,
            () = scope.on_cancel() => return Err("cancelled".into()),
        }
        .map_err(|error| error.to_string())?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let last = stderr.lines().rev().find(|line| !line.trim().is_empty());
        Err(format!(
            "the repo's setup failed ({}){}",
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
    ) -> Fut<'a, Result<LocalRun, String>> {
        Box::pin(async move {
            let runner = (self.runner)().ok_or("git is not available to the checks hub yet")?;
            let lock = self.lock_of(&ask.repo);
            let _turn = tokio::select! {
                turn = lock.lock() => turn,
                () = scope.on_cancel() => return Err("cancelled".into()),
            };
            let git = Git::new(runner.clone(), scope.clone());
            let path = self.checkout(&git, &ask.repo, &ask.sha).await?;
            self.setup(&path, &runner, &scope).await?;
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
            let id: Mutex<Option<String>> = Mutex::new(None);
            let named = || {
                id.lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .clone()
            };
            let read = async {
                while let Ok(Some(line)) = lines.next_line().await {
                    if named().is_none()
                        && let Some(found) = run_id_of(&line)
                    {
                        *id.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) =
                            Some(found.to_owned());
                        if let Some(started) = started.take() {
                            started(found);
                        }
                    }
                }
                child.wait().await
            };
            let ended = tokio::select! {
                ended = read => ended,
                () = scope.on_cancel() => {
                    if let Some(id) = named() {
                        // The runner outlives the starter: it is told to stop through its own journal.
                        self.cancel(&id, &runner).await;
                    }
                    return Err("cancelled".into());
                }
            };
            let status = ended.map_err(|error| error.to_string())?;
            let id = named()
                .ok_or_else(|| format!("ompdesk check ended ({status}) before it named its run"))?;
            let journals = Arc::clone(&self.journals);
            let found = id.clone();
            tokio::task::spawn_blocking(move || journals.run_blocking(&found))
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("the journal of run {id} could not be read"))
        })
    }
}

#[cfg(test)]
#[path = "local_run_tests.rs"]
mod tests;
