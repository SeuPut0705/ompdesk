//! gh, the GitHub CLI. The PR Center (`pr.rs`, was the logic of `src/main/local/git/pr.ts` and of `parse.ts`'s
//! `parsePrUnifiedDiff`, `rollupChecks`, `rollupCounts`), the GitHub center (`center.rs`, was `github.ts`'s
//! operations), the GitHub sign-in's gh and git runs (`auth.rs`, was `src/main/github-auth/cli.ts`) and a routine's
//! GitHub reads (`routines/github.rs`) run their whole sequence of gh and git runs here, each one request. gh's other
//! callers keep their logic in main (autopilot's release poll) and reach gh through the two contracts `exec.ts` had:
//! `gh.run` (`gh()`: stdout as text, a failure on a non-zero exit or a cut output) and `gh.text` (`ghText()`: 30 s,
//! every exit code answered).
//!
//! Main decides how gh runs (`ghRunner` in `exec.ts`: the binary `resolveBin("gh")` found, gh's non-interactive
//! environment over the one git gets, the timeout and the output cap) and hands it over with every request, `null` when
//! gh is not installed (the request then answers `gh_missing` where the TypeScript threw it); git's runner comes along
//! for the checkout root and a PR draft's commits. A file gh reads a body from (`--body-file`, `--notes-file`) is made
//! here and removed once its gh exited, also when the request failed or was cancelled.
//!
//! A token never leaves through a message: the values of gh's token variables in the environment main sent are
//! replaced by `***` in every fault this module answers and in the stderr `gh.text` answers (stdout is data its callers
//! read, and passes as gh printed it). Nothing here logs a request or its environment.

mod auth;
mod center;
mod json;
mod pr;

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::fs::disk;
use crate::fs::error::{Codes, NodeError};
use crate::fs::order::js_trim;
use crate::git::run::Git;
use crate::run::{Exec, Opts, Runner};
use crate::server::{Fault, Registry, Reply, Scope};

/// What a request answers where `requireGithubRepo` and `githubCommand` threw `gh_missing`.
const MISSING: &str = "GitHub CLI (gh) is not installed — see https://cli.github.com";
/// `ghText`'s fixed timeout.
const TEXT_TIMEOUT_MS: u64 = 30_000;
/// The variables gh reads a token from.
const TOKEN_VARIABLES: [&str; 4] = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
];
/// Shorter values are no token, and replacing them would mangle ordinary words.
const SHORTEST_SECRET: usize = 8;

/// The gh runs of one request: main's runner (none when gh is not installed), held to the request's scope.
pub struct Gh {
    exec: Option<Exec>,
    secrets: Vec<String>,
}

/// What `ghText` answered.
#[derive(Serialize)]
pub struct TextOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Gh {
    pub fn new(runner: Option<Runner>, scope: Scope) -> Gh {
        let secrets = runner
            .iter()
            .flat_map(|runner| &runner.env)
            .filter(|(name, value)| {
                value.len() >= SHORTEST_SECRET
                    && TOKEN_VARIABLES
                        .iter()
                        .any(|token| name.eq_ignore_ascii_case(token))
            })
            .map(|(_, value)| value.clone())
            .collect();
        Gh {
            exec: runner.map(|runner| Exec::new(runner, scope, "gh")),
            secrets,
        }
    }

    fn exec(&self) -> Result<&Exec, Fault> {
        self.exec
            .as_ref()
            .ok_or_else(|| Fault::new("gh_missing", MISSING))
    }

    /// Fails `gh_missing` when gh is not installed.
    pub fn require(&self) -> Result<(), Fault> {
        self.exec().map(|_| ())
    }

    /// `gh()`: stdout as text; a non-zero exit fails with gh's stderr (else `gh <a> <b> exited with code <n>`), an
    /// output past the cap with `gh <a> <b> output exceeded the size cap`.
    pub async fn call(&self, cwd: &str, args: &[&str], opts: Opts<'_>) -> Result<String, Fault> {
        let output = self.exec()?.run(cwd, args, opts).await?;
        let command = args[..args.len().min(2)].join(" ");
        if output.code != 0 {
            let stderr = js_trim(&output.stderr);
            let message = if stderr.is_empty() {
                format!("gh {command} exited with code {}", output.code)
            } else {
                stderr.to_owned()
            };
            return Err(Fault::new("gh_exit", message));
        }
        if output.truncated {
            return Err(Fault::new(
                "gh_exit",
                format!("gh {command} output exceeded the size cap"),
            ));
        }
        Ok(output.text())
    }

    /// `ghText()`: run to completion in 30 s and answer whatever the exit code.
    pub async fn text(&self, cwd: &str, args: &[&str]) -> Result<TextOutput, Fault> {
        let opts = Opts {
            timeout_ms: Some(TEXT_TIMEOUT_MS),
            ..Opts::default()
        };
        let output = self.exec()?.run(cwd, args, opts).await?;
        Ok(TextOutput {
            code: output.code,
            stdout: output.text(),
            stderr: self.scrub(output.stderr),
        })
    }

    pub(crate) fn scrub(&self, mut text: String) -> String {
        for secret in &self.secrets {
            if text.contains(secret.as_str()) {
                text = text.replace(secret.as_str(), "***");
            }
        }
        text
    }

    /// The request's answer, no fault carrying a token.
    fn answer(&self, outcome: Result<Reply, Fault>) -> Result<Reply, Fault> {
        outcome.map_err(|fault| Fault {
            message: self.scrub(fault.message),
            ..fault
        })
    }
}

/// gh and git for one request: git finds the checkout root (`repoRoot`) and a draft's commits.
pub struct Tools {
    pub gh: Gh,
    git: Option<Git>,
}

impl Tools {
    fn new(runners: Runners, scope: Scope) -> Tools {
        Tools {
            gh: Gh::new(runners.gh, scope.clone()),
            git: runners.git.map(|runner| Git::new(runner, scope)),
        }
    }

    /// `gitRunner()`'s refusal when git is missing.
    pub fn git(&self) -> Result<&Git, Fault> {
        self.git
            .as_ref()
            .ok_or_else(|| Fault::new("git_missing", "git is not installed or not on PATH"))
    }
}

/// A private file gh reads a text from: `<temp>/omp-pr-body-XXXXXX/body.md` (`withBodyFile`), removed with its folder
/// when dropped.
pub struct BodyFile {
    dir: PathBuf,
    path: String,
}

impl BodyFile {
    pub async fn new(text: &str) -> Result<BodyFile, Fault> {
        let text = text.to_owned();
        tokio::task::spawn_blocking(move || {
            let dir = disk::make_temp_dir("omp-pr-body-")?;
            let file = dir.join("body.md");
            let path = file.to_string_lossy().into_owned();
            let body = BodyFile { dir, path };
            std::fs::write(&file, text)
                .map_err(|error| NodeError::new(&error, "open", Some(&body.path)))?;
            Ok(body)
        })
        .await
        .map_err(|_| Fault::new("internal", "The body file's disk work panicked"))?
        .map_err(|error: NodeError| error.fault(Codes::None))
    }

    pub fn path(&self) -> &str {
        &self.path
    }
}

impl Drop for BodyFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// How gh and git run, as main hands them over; none for a tool that is not installed.
#[derive(Deserialize)]
struct Runners {
    gh: Option<Runner>,
    #[serde(default)]
    git: Option<Runner>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunParams {
    gh: Runner,
    cwd: String,
    args: Vec<String>,
    timeout_ms: Option<u64>,
    #[serde(default)]
    env: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct TextParams {
    gh: Runner,
    cwd: String,
    args: Vec<String>,
}

#[derive(Deserialize)]
struct At {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
}

/// A PR number the page sent: JSON carries no NaN or infinity, which arrive as `null`.
#[derive(Deserialize)]
struct Numbered {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    number: Option<f64>,
}

#[derive(Deserialize)]
struct ListParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    state: Option<String>,
    limit: Option<f64>,
    #[serde(default)]
    view: pr::View,
}

#[derive(Deserialize)]
struct DiffParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    number: Option<f64>,
    path: String,
}

#[derive(Deserialize)]
struct DraftParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    base: Option<String>,
    head: Option<String>,
}

/// `timeoutMs`: `gh pr create`'s or `gh pr merge`'s timeout, main's to choose.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    #[serde(flatten)]
    input: pr::CreateInput,
    timeout_ms: u64,
}

/// A PR number main checked (a safe positive integer).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    number: u64,
    method: pr::MergeMethod,
    #[serde(default)]
    delete_branch: bool,
    timeout_ms: u64,
}

/// `body`: trimmed by main, which refused an empty one where the event needs text.
#[derive(Deserialize)]
struct ReviewParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    number: u64,
    event: pr::ReviewEvent,
    body: String,
}

#[derive(Deserialize)]
struct CommentParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    number: u64,
    body: String,
}

#[derive(Deserialize)]
struct CommentsParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    number: u64,
}

#[derive(Deserialize)]
struct EditParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    number: u64,
    title: Option<String>,
    body: Option<String>,
    base: Option<String>,
}

/// `request`: what `parseGithubRequest` passed; `cloneTimeoutMs`, `logTimeoutMs`: main's timeouts of a clone and of a
/// run log.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CenterParams {
    #[serde(flatten)]
    runners: Runners,
    cwd: String,
    request: serde_json::Value,
    clone_timeout_ms: u64,
    log_timeout_ms: u64,
}

pub fn register(registry: &mut Registry) {
    auth::register(registry);
    registry.add("gh.run", |call| {
        Box::pin(async move {
            let RunParams {
                gh,
                cwd,
                args,
                timeout_ms,
                env,
            } = call.params()?;
            let gh = Gh::new(Some(gh), call.scope);
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            let env: Vec<(&str, &str)> =
                env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            let opts = Opts {
                timeout_ms,
                env: &env,
                ..Opts::default()
            };
            let outcome = gh.call(&cwd, &args, opts).await;
            gh.answer(outcome.and_then(|stdout| Reply::json(&stdout)))
        })
    });
    registry.add("gh.text", |call| {
        Box::pin(async move {
            let TextParams { gh, cwd, args } = call.params()?;
            let gh = Gh::new(Some(gh), call.scope);
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            let outcome = gh.text(&cwd, &args).await;
            gh.answer(outcome.and_then(|output| Reply::json(&output)))
        })
    });
    registry.add("gh.repo", |call| {
        Box::pin(async move {
            let At { runners, cwd } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::repo(&tools, &cwd).await;
            tools.gh.answer(outcome.and_then(|repo| Reply::json(&repo)))
        })
    });
    registry.add("gh.prRepo", |call| {
        Box::pin(async move {
            let At { runners, cwd } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::availability(&tools, &cwd).await;
            tools.gh.answer(outcome.and_then(|repo| Reply::json(&repo)))
        })
    });
    registry.add("gh.prList", |call| {
        Box::pin(async move {
            let ListParams {
                runners,
                cwd,
                state,
                limit,
                view,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::list(&tools, &cwd, state.as_deref(), limit, view).await;
            tools.gh.answer(outcome.and_then(|rows| Reply::json(&rows)))
        })
    });
    registry.add("gh.prGet", |call| {
        Box::pin(async move {
            let Numbered {
                runners,
                cwd,
                number,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::detail(&tools, &cwd, number).await;
            tools
                .gh
                .answer(outcome.and_then(|detail| Reply::json(&detail)))
        })
    });
    registry.add("gh.prDiff", |call| {
        Box::pin(async move {
            let DiffParams {
                runners,
                cwd,
                number,
                path,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::diff(&tools, &cwd, number, &path).await;
            tools.gh.answer(outcome.and_then(|diff| Reply::json(&diff)))
        })
    });
    registry.add("gh.prDraftFacts", |call| {
        Box::pin(async move {
            let DraftParams {
                runners,
                cwd,
                base,
                head,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::draft_facts(&tools, &cwd, base, head).await;
            tools
                .gh
                .answer(outcome.and_then(|facts| Reply::json(&facts)))
        })
    });
    registry.add("gh.prCreate", |call| {
        Box::pin(async move {
            let CreateParams {
                runners,
                cwd,
                input,
                timeout_ms,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::create(&tools, &cwd, &input, timeout_ms).await;
            tools
                .gh
                .answer(outcome.and_then(|created| Reply::json(&created)))
        })
    });
    registry.add("gh.prMerge", |call| {
        Box::pin(async move {
            let MergeParams {
                runners,
                cwd,
                number,
                method,
                delete_branch,
                timeout_ms,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::merge(&tools, &cwd, number, method, delete_branch, timeout_ms).await;
            tools
                .gh
                .answer(outcome.and_then(|merged| Reply::json(&merged)))
        })
    });
    registry.add("gh.prReview", |call| {
        Box::pin(async move {
            let ReviewParams {
                runners,
                cwd,
                number,
                event,
                body,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::review(&tools, &cwd, number, event, &body).await;
            tools
                .gh
                .answer(outcome.and_then(|submitted| Reply::json(&submitted)))
        })
    });
    registry.add("gh.prComment", |call| {
        Box::pin(async move {
            let CommentParams {
                runners,
                cwd,
                number,
                body,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::comment(&tools, &cwd, number, &body).await;
            tools
                .gh
                .answer(outcome.and_then(|submitted| Reply::json(&submitted)))
        })
    });
    registry.add("gh.prComments", |call| {
        Box::pin(async move {
            let CommentsParams {
                runners,
                cwd,
                number,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let outcome = pr::comments(&tools, &cwd, number).await;
            tools
                .gh
                .answer(outcome.and_then(|comments| Reply::json(&comments)))
        })
    });
    registry.add("gh.prEdit", |call| {
        Box::pin(async move {
            let EditParams {
                runners,
                cwd,
                number,
                title,
                body,
                base,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let edit = pr::Edit {
                title: title.as_deref(),
                body: body.as_deref(),
                base: base.as_deref(),
            };
            let outcome = pr::edit(&tools, &cwd, number, edit).await;
            tools
                .gh
                .answer(outcome.and_then(|edited| Reply::json(&edited)))
        })
    });
    registry.add("gh.github", |call| {
        Box::pin(async move {
            let CenterParams {
                runners,
                cwd,
                request,
                clone_timeout_ms,
                log_timeout_ms,
            } = call.params()?;
            let tools = Tools::new(runners, call.scope);
            let timeouts = center::Timeouts {
                clone_ms: clone_timeout_ms,
                log_ms: log_timeout_ms,
            };
            let outcome = center::command(&tools, &cwd, &request, timeouts).await;
            tools.gh.answer(outcome)
        })
    });
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::run::tests::shell;

    const TOKEN: &str = "ghp_Z9y8Z9y8Z9y8Z9y8Z9y8Z9y8Z9y8Z9y8Z9y8";

    /// A gh that is `/bin/sh -c` with a token in its environment, as main hands one over when the person exported it.
    fn gh_with_token(timeout_ms: u64, max_bytes: usize) -> Gh {
        let mut runner = shell(timeout_ms, max_bytes);
        runner.env.insert("GH_TOKEN".into(), TOKEN.into());
        runner.env.insert("github_token".into(), TOKEN.into());
        runner.env.insert("PATH".into(), "/usr/bin:/bin".into());
        Gh::new(Some(runner), Scope::detached())
    }

    #[tokio::test]
    async fn answers_gh_s_failures_as_the_typescript_threw_them() {
        let gh = gh_with_token(10_000, 1024);
        let silent = gh.call("/", &["exit 3", "b", "c"], Opts::default()).await;
        assert_eq!(
            silent.unwrap_err().message,
            "gh exit 3 b exited with code 3"
        );
        let said = gh
            .call("/", &["echo ' no such pr ' >&2; exit 1"], Opts::default())
            .await;
        assert_eq!(said.unwrap_err().message, "no such pr");
        let cut = Gh::new(Some(shell(10_000, 4)), Scope::detached())
            .call("/", &["printf 0123456789"], Opts::default())
            .await;
        assert_eq!(
            cut.unwrap_err().message,
            "gh printf 0123456789 output exceeded the size cap"
        );
        let text = gh
            .text("/", &["echo out; echo err >&2; exit 4"])
            .await
            .unwrap();
        assert_eq!(
            (text.code, text.stdout.as_str(), text.stderr.as_str()),
            (4, "out\n", "err\n")
        );
        let missing = Gh::new(None, Scope::detached())
            .call("/", &["x"], Opts::default())
            .await;
        assert_eq!(missing.unwrap_err(), Fault::new("gh_missing", MISSING));
    }

    /// Every way a gh run fails, with a token in its environment that the stand-in prints: no message, no stderr the
    /// core answers and nothing the core writes to its own stderr carries it.
    #[tokio::test]
    async fn a_failing_gh_reports_nothing_of_a_token_in_its_environment() {
        let gh = gh_with_token(300, 8);
        let failed = gh
            .call(
                "/",
                &["echo \"bad credentials $GH_TOKEN\" >&2; exit 1"],
                Opts::default(),
            )
            .await
            .unwrap_err();
        let timed_out = gh
            .call("/", &["sleep 5 # $GH_TOKEN"], Opts::default())
            .await
            .unwrap_err();
        let cut = gh
            .call("/", &["echo \"$GH_TOKEN\""], Opts::default())
            .await
            .unwrap_err();
        let text = gh
            .text("/", &["echo \"$GH_TOKEN\" >&2; exit 2"])
            .await
            .unwrap();
        let mut runner = shell(1_000, 8);
        runner.bin = "/no/such/gh".into();
        runner.env.insert("GH_TOKEN".into(), TOKEN.into());
        let spawn = Gh::new(Some(runner), Scope::detached())
            .call("/", &["x"], Opts::default())
            .await
            .unwrap_err();
        let answered = |fault: Fault| gh.answer(Err(fault)).err().unwrap().message;
        let messages = [
            answered(failed),
            answered(timed_out),
            answered(cut),
            answered(spawn),
            text.stderr.clone(),
        ];
        assert_eq!(messages[0], "bad credentials ***");
        assert_eq!(text.stderr, "***\n");
        for message in &messages {
            assert!(!message.contains(TOKEN), "{message}");
            assert!(!message.contains(&TOKEN[4..20]), "{message}");
        }
    }

    #[tokio::test]
    async fn removes_a_body_file_with_its_folder() {
        let body = BodyFile::new("Body 한").await.unwrap();
        let file = PathBuf::from(body.path());
        let dir = file.parent().unwrap().to_path_buf();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "Body 한");
        assert!(
            dir.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("omp-pr-body-")
        );
        assert_eq!(file.file_name().unwrap(), "body.md");
        drop(body);
        assert!(!dir.exists());
    }

    /// A cancelled request's gh is ended before the call returns, and only then is its body file removed: the file
    /// outlives the process that reads it, and nothing outlives the request.
    #[tokio::test]
    async fn a_cancelled_gh_has_exited_before_its_body_file_goes() {
        let marker =
            std::env::temp_dir().join(format!("ompdesk-core-gh-body-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let scope = Scope::detached();
        let gh = Gh::new(Some(shell(60_000, 1024)), scope.clone());
        let body = BodyFile::new("text").await.unwrap();
        let dir = PathBuf::from(body.path()).parent().unwrap().to_path_buf();
        let script = format!(
            "trap 'cat \"$0\" > \"{marker}\"; exit 1' TERM; touch \"{marker}.up\"; while :; do sleep 0.05; done",
            marker = marker.display()
        );
        let args = [script.as_str(), body.path()];
        let started = format!("{}.up", marker.display());
        let (outcome, ()) = tokio::join!(gh.call("/", &args, Opts::default()), async {
            while !std::path::Path::new(&started).exists() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            scope.cancel();
        });
        assert_eq!(outcome.unwrap_err(), Fault::cancelled());
        // The process read the body after the cancel's SIGTERM: the file was there until it exited.
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "text");
        drop(body);
        assert!(!dir.exists());
        let _ = std::fs::remove_file(&marker);
        let _ = std::fs::remove_file(started);
    }
}
