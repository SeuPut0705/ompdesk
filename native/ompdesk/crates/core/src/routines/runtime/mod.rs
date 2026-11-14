//! Live native routine drivers. The dependency boundary supplies canonical tools, pool events and mailbox
//! credentials; all source polling, watch/debounce, filtering and cancellation execute here.

mod email;
mod files;
mod git;
mod github;
mod sessions;
mod watch;

use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::watch as signal;

use crate::server::{Fault, Scope};

pub use super::imap::{MailCursor, MailMessage, Mailbox, MailboxRead};
pub use crate::run::Runner as ToolRunner;
pub use sessions::{Activity, Outcome, SessionNotice, SessionSubscription, SessionTab};

pub type Stop = Arc<dyn Fn() + Send + Sync>;

pub struct SourceProcess {
    pub stop: Stop,
    pub run_ended: Option<Stop>,
    /// Settles after the watcher and timers are gone and every cancelled native process has exited.
    done: Option<Pin<Box<dyn Future<Output = ()> + Send>>>,
}

impl SourceProcess {
    pub fn take_done(&mut self) -> Option<Pin<Box<dyn Future<Output = ()> + Send>>> {
        self.done.take()
    }
}

impl Drop for SourceProcess {
    fn drop(&mut self) {
        (self.stop)();
    }
}

pub struct GithubTool {
    pub runner: Option<ToolRunner>,
    pub home: PathBuf,
}

/// Native adapters delegate directly to the canonical Machine, pool and account services. No source-level
/// callback or default implementation can replace a driver.
pub trait Services: Send + Sync + 'static {
    fn git(&self) -> impl Future<Output = Result<ToolRunner, Fault>> + Send;
    fn github(&self) -> impl Future<Output = Result<GithubTool, Fault>> + Send;
    fn sessions(&self) -> Result<SessionSubscription, Fault>;
    fn mailbox(&self, name: &str) -> impl Future<Output = Result<Option<Mailbox>, Fault>> + Send;
}

pub trait Sink: Clone + Send + Sync + 'static {
    fn current(&self) -> bool;
    fn running(&self) -> bool;
    fn quiet(&self) -> bool;
    fn publish(&self, mark: Option<Value>, lines: &[String]) -> bool;
    fn failure(&self, key: &str, error: Option<&str>);
}

#[derive(Clone, Copy)]
pub struct Config {
    pub github_poll: Duration,
    pub git_poll: Duration,
    pub email_poll: Duration,
    pub file_debounce: Duration,
    pub file_max_wait: Duration,
    pub file_retry: Duration,
    pub scan_poll: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            github_poll: Duration::from_secs(5 * 60),
            git_poll: Duration::from_secs(30),
            email_poll: Duration::from_secs(2 * 60),
            file_debounce: Duration::from_secs(2),
            file_max_wait: Duration::from_secs(10),
            file_retry: Duration::from_secs(60),
            scan_poll: Duration::from_millis(300),
        }
    }
}

fn locked<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn text(value: &Value, field: &str) -> Result<String, Fault> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            Fault::new(
                "schedule_error",
                format!("The routine's {field} is not text"),
            )
        })
}

fn texts(value: &Value, field: &str) -> Result<Vec<String>, Fault> {
    value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| {
            Fault::new(
                "schedule_error",
                format!("The routine's {field} is not a list"),
            )
        })?
        .iter()
        .map(|value| {
            value.as_str().map(str::to_owned).ok_or_else(|| {
                Fault::new(
                    "schedule_error",
                    format!("The routine's {field} holds something other than text"),
                )
            })
        })
        .collect()
}

pub fn start<S: Services, C: Sink>(
    services: Arc<S>,
    schedule: &Value,
    mark: Option<Value>,
    sink: C,
    config: Config,
) -> Result<SourceProcess, Fault> {
    let event = &schedule["frequency"]["event"];
    let source = text(event, "source")?;
    let spec = match source.as_str() {
        "github" => Spec::Github {
            repo: text(event, "repo")?,
            events: texts(event, "events")?,
        },
        "files" => Spec::Files {
            path: text(event, "path")?,
        },
        "git" => Spec::Git {
            repo: text(event, "repo")?,
            branch: text(event, "branch")?,
        },
        "session" => Spec::Session(sessions::Options {
            events: texts(event, "events")?,
            folder: event["folder"].as_str().map(str::to_owned),
            wake_session: schedule["wakeSession"].as_str().map(str::to_owned),
        }),
        "email" => Spec::Email(email::Options {
            account: text(event, "account")?,
            from: event["from"].as_str().map(str::to_owned),
            subject: event["subject"].as_str().map(str::to_owned),
            to: event["to"].as_str().map(str::to_owned),
        }),
        "webhook" => {
            return Err(Fault::new(
                "schedule_error",
                "A webhook is answered by the web server",
            ));
        }
        _ => {
            return Err(Fault::new(
                "schedule_error",
                "The routine has an unknown source",
            ));
        }
    };
    let (scope, gone) = Scope::watched();
    let stop_scope = Arc::new(Mutex::new(Some(scope.clone())));
    let stopped = Arc::clone(&stop_scope);
    let stop: Stop = Arc::new(move || {
        if let Some(scope) = locked(&stopped).take() {
            scope.cancel();
        }
    });
    let (rebased, rebase) = signal::channel(0_u64);
    let run_ended = matches!(spec, Spec::Git { .. }).then(|| {
        Arc::new(move || {
            rebased.send_modify(|revision| *revision = revision.wrapping_add(1));
        }) as Stop
    });
    let failed = sink.clone();
    let finished = Arc::clone(&stop_scope);
    let task = tokio::spawn(async move {
        match spec {
            Spec::Github { repo, events } => {
                github::run(services, repo, events, mark, sink, &scope, config).await
            }
            Spec::Files { path } => files::run(path, mark, sink, &scope, config).await,
            Spec::Git { repo, branch } => {
                git::run(services, (repo, branch), mark, sink, &scope, rebase, config).await
            }
            Spec::Session(options) => sessions::run(services, options, sink, &scope).await,
            Spec::Email(options) => email::run(services, options, mark, sink, &scope, config).await,
        }
    });
    Ok(SourceProcess {
        stop,
        run_ended,
        done: Some(Box::pin(async move {
            let result = task.await;
            if let Some(scope) = locked(&finished).take() {
                scope.cancel();
            }
            gone.wait().await;
            if result.is_err() {
                failed.failure("trigger", Some("its native source task ended unexpectedly"));
            }
        })),
    })
}

enum Spec {
    Github { repo: String, events: Vec<String> },
    Files { path: String },
    Git { repo: String, branch: String },
    Session(sessions::Options),
    Email(email::Options),
}

async fn wait(scope: &Scope, duration: Duration) -> bool {
    tokio::select! { biased; _ = scope.on_cancel() => false, _ = tokio::time::sleep(duration) => true }
}

#[cfg(test)]
mod tests;
