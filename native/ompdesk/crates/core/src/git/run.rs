//! Running one git: the shared runner (`crate::run`) with git's own failure, `GitCommandError`'s message.

use crate::fs::order::js_trim;
use crate::run::{Exec, Opts, Output, Runner};
use crate::server::{Fault, Scope};

/// The gits of one request: main's runner, held to the request's scope.
pub struct Git(Exec);

/// `GitCommandError`: git's stderr, else `git <command> exited with code <n>`. Its code is no app code: main's
/// callers read the message, a mutation reports it as `git_failed`.
pub fn failure(args: &[&str], output: &Output) -> Fault {
    let stderr = js_trim(&output.stderr);
    let message = if stderr.is_empty() {
        format!(
            "git {} exited with code {}",
            args.first().unwrap_or(&""),
            output.code
        )
    } else {
        stderr.to_owned()
    };
    Fault::new("git_exit", message)
}

impl Git {
    pub fn new(runner: Runner, scope: Scope) -> Git {
        Git(Exec::new(runner, scope, "git"))
    }

    /// `gitRaw`: answers whatever git's exit code; fails only when git could not run, ran past its timeout or the
    /// request was cancelled.
    pub async fn raw(&self, cwd: &str, args: &[&str]) -> Result<Output, Fault> {
        self.0.run(cwd, args, Opts::default()).await
    }

    /// `gitRaw` with its own output cap.
    pub async fn capped(
        &self,
        cwd: &str,
        args: &[&str],
        max_bytes: usize,
    ) -> Result<Output, Fault> {
        let opts = Opts {
            max_bytes: Some(max_bytes),
            ..Opts::default()
        };
        self.0.run(cwd, args, opts).await
    }

    /// `git`: stdout as text; git's own failure is a fault with its stderr (`GitCommandError`'s message).
    pub async fn text(&self, cwd: &str, args: &[&str]) -> Result<String, Fault> {
        self.text_with(cwd, args, Opts::default()).await
    }

    /// `git` with its own settings.
    pub async fn text_with(
        &self,
        cwd: &str,
        args: &[&str],
        opts: Opts<'_>,
    ) -> Result<String, Fault> {
        let output = self.0.run(cwd, args, opts).await?;
        if output.code != 0 {
            return Err(failure(args, &output));
        }
        Ok(output.text())
    }

    pub async fn run(&self, cwd: &str, args: &[&str], opts: Opts<'_>) -> Result<Output, Fault> {
        self.0.run(cwd, args, opts).await
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::BTreeMap;

    use super::*;

    /// The runner main hands over, for a git on this machine's PATH.
    pub fn runner() -> Runner {
        let mut env: BTreeMap<String, String> = std::env::vars()
            .filter(|(name, _)| !name.starts_with("GIT_"))
            .collect();
        env.insert("GIT_OPTIONAL_LOCKS".into(), "0".into());
        env.insert("LC_ALL".into(), "C".into());
        Runner {
            bin: "git".into(),
            args: ["-c", "core.quotepath=false", "-c", "color.ui=false"]
                .map(String::from)
                .to_vec(),
            env,
            timeout_ms: 60_000,
            max_bytes: 8 * 1024 * 1024,
        }
    }

    /// That runner outside any request.
    pub fn git() -> Git {
        Git::new(runner(), Scope::detached())
    }

    #[tokio::test]
    async fn fails_with_git_s_own_words() {
        let dir = std::env::temp_dir();
        let fault = git()
            .text(dir.to_str().unwrap(), &["no-such-command-here"])
            .await
            .err()
            .unwrap();
        assert!(!fault.message.is_empty());
        assert_eq!(fault.code, "git_exit");
        let empty = Output {
            code: 3,
            stdout: Vec::new(),
            stderr: " \n".into(),
            truncated: false,
        };
        assert_eq!(
            failure(&["push", "x"], &empty).message,
            "git push exited with code 3"
        );
    }

    #[tokio::test]
    async fn starts_no_git_once_its_request_was_cancelled() {
        let scope = Scope::detached();
        scope.cancel();
        let fault = Git::new(runner(), scope)
            .raw("/no/such/folder/here", &["status"])
            .await
            .err()
            .unwrap();
        assert_eq!(fault, Fault::cancelled());
    }
}
