use std::sync::Arc;

use serde_json::Value;

use super::{Config, Services, Sink, wait};
use crate::gh::Gh;
use crate::routines::{
    GhApi,
    github::{self, Kind, State},
};
use crate::server::Scope;

pub(super) async fn run<S: Services, C: Sink>(
    services: Arc<S>,
    repo: String,
    events: Vec<String>,
    mark: Option<Value>,
    sink: C,
    scope: &Scope,
    config: Config,
) {
    let kinds = [
        Kind::PullRequest,
        Kind::Issue,
        Kind::CiFailure,
        Kind::Release,
        Kind::Push,
    ];
    let mut state = State::restore(mark.as_ref());
    loop {
        for kind in kinds
            .iter()
            .copied()
            .filter(|kind| events.iter().any(|event| event == kind.name()))
        {
            if scope.cancelled() || !sink.current() {
                return;
            }
            let key = format!("github {repo}: {}", kind.name());
            let tools = tokio::select! { biased; _ = scope.on_cancel() => return, tools = services.github() => tools };
            let result = match tools {
                Ok(tools) => {
                    let gh = Gh::new(tools.runner, scope.clone());
                    let home = tools.home.to_string_lossy();
                    github::read(
                        &GhApi {
                            gh: &gh,
                            home: &home,
                            timeout_ms: 30_000,
                        },
                        &repo,
                        kind,
                        &mut state,
                    )
                    .await
                }
                Err(error) => Err(error.message),
            };
            if scope.cancelled() || !sink.current() {
                return;
            }
            match result {
                Ok(lines) => {
                    sink.failure(&key, None);
                    if !sink.publish(Some(state.mark()), &lines) {
                        return;
                    }
                }
                Err(error) => sink.failure(&key, Some(&error)),
            }
        }
        if !wait(scope, config.github_poll).await {
            return;
        }
    }
}
