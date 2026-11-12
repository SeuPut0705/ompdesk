//! Routine triggers' reads and rules (unit 4e). Main keeps each trigger's live part: the schedule service's state, the
//! poll and burst timers, the file watcher, the tab pool's activity, the marks file and the email trigger with its
//! IMAP client; this module answers what a trigger reads and says.
//!
//! - `routines.github`: one read of one kind of a GitHub trigger (`github.rs`), gh run as main's `ghRunner` says.
//! - `routines.filesScan`, `routines.filesChanged`: a files trigger's listing and what changed while OMPdesk was
//!   closed (`files.rs`).
//! - The git trigger's two reads are `git.routineHead` and `git.routineCommits` (`git/triggers.rs`), whose line is
//!   `text.rs`' `describe_commits`.
//!
//! Nothing here logs a request: a GitHub read's failure carries gh's words with the values of gh's token variables
//! replaced (`Gh::scrub`).

mod files;
mod github;
pub(crate) mod text;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::gh::Gh;
use crate::json::whole_surrogates;
use crate::run::{Opts, Runner};
use crate::server::{Fault, Registry, Reply};

/// What a GitHub read answers where `ghApi` threw it.
const GH_MISSING: &str = "the GitHub CLI (gh) is not installed";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubParams {
    /// Main's runner, `null` when gh is not installed.
    gh: Option<Runner>,
    /// Where gh runs: an endpoint names its repository, so no repository folder is needed.
    home: String,
    /// `owner/name`, checked by main (`usableRepo`).
    repo: String,
    kind: String,
    /// What the last read answered, when there was one; else `mark`, the last launch's.
    state: Option<github::State>,
    mark: Option<Value>,
    /// How long one `gh api` may take.
    timeout_ms: u64,
}

#[derive(Serialize)]
struct GithubAnswer {
    state: github::State,
    /// What to keep for the next launch (only after a read that did not fail).
    mark: Value,
    lines: Vec<String>,
    error: Option<String>,
}

struct GhApi<'a> {
    gh: &'a Gh,
    home: &'a str,
    timeout_ms: u64,
}

impl github::Api for GhApi<'_> {
    async fn get(&self, endpoint: &str) -> Result<Value, String> {
        let opts = Opts {
            timeout_ms: Some(self.timeout_ms),
            ..Opts::default()
        };
        let stdout = match self.gh.call(self.home, &["api", endpoint], opts).await {
            Ok(stdout) => stdout,
            Err(fault) if fault.code == "gh_missing" => return Err(GH_MISSING.into()),
            Err(fault) => return Err(self.gh.scrub(fault.message)),
        };
        serde_json::from_str(&whole_surrogates(&stdout)).map_err(|error| error.to_string())
    }
}

#[derive(Deserialize)]
struct ScanParams {
    path: String,
    /// Folder names never listed (`IGNORED_DIRS`).
    ignored: Vec<String>,
    /// Files a listing holds at most (`FILES_LISTING_MAX`).
    max: usize,
}

#[derive(Deserialize)]
struct ChangedParams {
    /// The mark the last launch left (JSON from disk), absent when none.
    mark: Option<Value>,
    /// This launch's first listing, as `routines.filesScan` answered it.
    listing: Option<files::Listing>,
}

pub fn register(registry: &mut Registry) {
    registry.add("routines.github", |call| {
        Box::pin(async move {
            let params: GithubParams = call.params()?;
            let kind = github::Kind::parse(&params.kind)
                .ok_or_else(|| Fault::new("invalid_params", "unknown GitHub event kind"))?;
            let mut state = match params.state {
                Some(state) => state,
                None => github::State::restore(params.mark.as_ref()),
            };
            let gh = Gh::new(params.gh, call.scope);
            let api = GhApi {
                gh: &gh,
                home: &params.home,
                timeout_ms: params.timeout_ms,
            };
            let outcome = github::read(&api, &params.repo, kind, &mut state).await;
            let (lines, error) = match outcome {
                Ok(lines) => (lines, None),
                Err(message) => (Vec::new(), Some(message)),
            };
            Reply::json(&GithubAnswer {
                mark: state.mark(),
                state,
                lines,
                error,
            })
        })
    });
    registry.add("routines.filesScan", |call| {
        Box::pin(async move {
            let ScanParams { path, ignored, max } = call.params()?;
            let listing = tokio::task::spawn_blocking(move || files::scan(&path, &ignored, max))
                .await
                .map_err(|error| Fault::new("internal", error.to_string()))??;
            Reply::json(&listing)
        })
    });
    registry.add("routines.filesChanged", |call| {
        Box::pin(async move {
            let ChangedParams { mark, listing } = call.params()?;
            let names = files::parse_mark(mark.as_ref())
                .map(|before| files::changed_names(before.as_ref(), listing.as_ref()));
            Reply::json(&names)
        })
    });
}

/// A table of `captured.json`: what the TypeScript answered for the same inputs before it was deleted (commit
/// `b0c90dd3`).
#[cfg(test)]
fn captured(table: &str) -> Vec<Value> {
    let rows: Value = serde_json::from_str(include_str!("captured.json")).unwrap();
    rows[table].as_array().unwrap().clone()
}
