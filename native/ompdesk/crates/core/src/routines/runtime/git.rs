use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::watch;
use tokio::time::Instant;

use super::{Config, Services, Sink};
use crate::git::{run::Git, triggers};
use crate::server::Scope;

pub(super) async fn run<S: Services, C: Sink>(
    services: Arc<S>,
    place: (String, String),
    mark: Option<Value>,
    sink: C,
    scope: &Scope,
    mut ended: watch::Receiver<u64>,
    config: Config,
) {
    let (repo, branch) = place;
    let mut baseline =
        mark.as_ref()
            .and_then(|mark| mark.get("head"))
            .and_then(|head| match head {
                Value::Null => Some(None),
                Value::String(head) => Some(Some(head.clone())),
                _ => None,
            });
    let period = config.git_poll.max(std::time::Duration::from_millis(1));
    let mut tick = Instant::now() + period;
    let mut rebase = false;
    loop {
        if scope.cancelled() || !sink.current() {
            return;
        }
        let revision = *ended.borrow_and_update();
        if sink.running() {
            rebase = true;
        } else {
            let runner = tokio::select! { biased; _ = scope.on_cancel() => return, runner = services.git() => runner };
            let result = match runner {
                Ok(runner) => {
                    Read {
                        git: Git::new(runner, scope.clone()),
                        repo: &repo,
                        branch: &branch,
                        ended: &ended,
                        sink: &sink,
                        scope,
                    }
                    .poll(&mut baseline, &mut rebase, revision)
                    .await
                }
                Err(error) => Err(error.message),
            };
            if scope.cancelled() || !sink.current() {
                return;
            }
            if let Err(error) = result {
                sink.failure(&format!("git {repo} {branch}: read"), Some(&error));
            }
        }
        if ended.has_changed().unwrap_or(false) {
            rebase = true;
            continue;
        }
        let now = Instant::now();
        if tick <= now {
            let remainder = (now - tick).as_nanos() % period.as_nanos();
            let wait = period.as_nanos() - remainder;
            tick = now
                + std::time::Duration::new(
                    (wait / 1_000_000_000) as u64,
                    (wait % 1_000_000_000) as u32,
                );
        }
        tokio::select! {
            biased;
            _ = scope.on_cancel() => return,
            changed = ended.changed() => { if changed.is_err() { return; } rebase = true; }
            _ = tokio::time::sleep_until(tick) => { tick += period; }
        }
    }
}

struct Read<'a, C: Sink> {
    git: Git,
    repo: &'a str,
    branch: &'a str,
    ended: &'a watch::Receiver<u64>,
    sink: &'a C,
    scope: &'a Scope,
}

impl<C: Sink> Read<'_, C> {
    async fn poll(
        &self,
        baseline: &mut Option<Option<String>>,
        rebase: &mut bool,
        revision: u64,
    ) -> Result<(), String> {
        let Self {
            git,
            repo,
            branch,
            ended,
            sink,
            scope,
        } = self;
        let head = triggers::routine_head(git, repo, branch)
            .await
            .map_err(|error| error.message)?;
        if scope.cancelled() || !sink.current() {
            return Ok(());
        }
        if sink.running() {
            *rebase = true;
            return Ok(());
        }
        sink.failure(&format!("git {repo} {branch}: read"), None);
        let Some(head) = head else {
            sink.failure(
                &format!("git {repo} {branch}: branch"),
                Some("the branch does not exist"),
            );
            if baseline.is_none() {
                *baseline = Some(None);
                sink.publish(Some(json!({"head":null})), &[]);
            }
            return Ok(());
        };
        sink.failure(&format!("git {repo} {branch}: branch"), None);
        let before = baseline.replace(Some(head.clone()));
        if before.as_ref().and_then(Option::as_ref) != Some(&head) {
            sink.publish(Some(json!({"head":head})), &[]);
        }
        if *rebase || *ended.borrow() != revision {
            *rebase = false;
            return Ok(());
        }
        let Some(Some(before)) = before.filter(|before| before.as_ref() != Some(&head)) else {
            return Ok(());
        };
        let line = triggers::routine_commits(git, repo, branch, &before, &head)
            .await
            .map_err(|error| error.message)?;
        if scope.cancelled() || !sink.current() || sink.running() || *ended.borrow() != revision {
            return Ok(());
        }
        if let Some(line) = line {
            sink.publish(None, &[line]);
        }
        Ok(())
    }
}
