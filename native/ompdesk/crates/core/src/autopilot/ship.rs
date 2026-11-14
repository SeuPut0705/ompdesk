//! Autopilot's ShipRunner (was `src/main/autopilot-ship.ts`): what main does to git on the run's behalf, one queue per
//! autopilot tab. The agent never pushes (the bridge guard blocks it); the runtime does, at the end of a turn, from the
//! sha it pins then: the push after a green cycle, landing a green cycle on the default branch (Automatic shipping), and
//! the buttons on the screen (push, PR, merge into the default branch, revert a cycle). A release is the agent's own
//! work, so it only appears here for display.
//!
//! Rules: explicit refspecs without `+` (a refusal stays a refusal), the remote by NAME with its own URL pinned as
//! `pushurl` through `GIT_CONFIG_*` (so a `pushInsteadOf` rule cannot redirect it), a conflicting merge or revert is
//! aborted, one failed item never blocks the next, and every ref move is journaled before it happens so the audit
//! (`audit.rs`) expects exactly it. Landing never merges into the run's worktree (the next turn may already be working in
//! it): when the default branch moved on and merges cleanly, the merge commit is built without a checkout, the cycle's
//! own check runs on exactly that commit in a temporary checkout (`land_check.rs`), and only that commit is pushed, as a
//! fast-forward. A merge that conflicts or fails its check is reported, and the agent merges, checks and commits in its
//! next cycle.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::MainPort;
use super::land_check::{self, Input as CheckInput, LandCheck};
use super::steps::{Ended, Steps};
use crate::fs::order::{is_js_space, js_trim};
use crate::git::run::Git;
use crate::run::{Opts, Output};
use crate::server::Fault;

pub type Fut<T> = std::pin::Pin<Box<dyn Future<Output = T> + Send>>;

const PUSH_TIMEOUT_MS: u64 = 180_000;
const GIT_TIMEOUT_MS: u64 = 120_000;
/// The longest one drain runs: a land builds up to `LAND_ATTEMPTS` candidates, each checked for up to 30 min
/// (`LAND_CHECK_TIMEOUT_MS`) after a worktree add and a setup hook, with git calls between. Every step has its own
/// timeout, so this only ends a drain whose step never reported back; the queue is then free again.
pub const SHIP_DRAIN_MAX_MS: u64 = 3 * 60 * 60_000;
/// Finished items kept for the screen.
const KEEP_FINISHED: usize = 20;
/// Candidates a land builds when the default branch keeps moving (each checked); then the next cycle tries again.
const LAND_ATTEMPTS: u32 = 3;

const NETWORK_FAILURE: [&str; 10] = [
    "could not resolve host",
    "unable to access",
    "connection refused",
    "connection reset",
    "connection timed out",
    "timed out",
    "network is unreachable",
    "no route to host",
    "does not appear to be a git repository",
    "could not read from remote",
];
const REFUSED_FIRST: [&str; 7] = [
    "rejected",
    "denied",
    "permission",
    "authentication",
    "could not read username",
    "terminal prompts disabled",
    "protected branch",
];
/// A refused push that is the default branch moving on, not a rule against pushing there.
const MOVED_ON: [&str; 4] = [
    "non-fast-forward",
    "fetch first",
    "stale info",
    "(already exists)",
];
/// A refusal that is the account, not the branch: a pull request would be refused as well.
const NOT_ALLOWED_AT_ALL: [&str; 4] = [
    "could not read username",
    "authentication failed",
    "terminal prompts disabled",
    "invalid credentials",
];

fn mentions(text: &str, words: &[&str]) -> bool {
    let lowered = text.to_lowercase();
    words.iter().any(|word| lowered.contains(word))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PushFailure {
    Rejected,
    Network,
}

/// A failed push's stderr: refused or authentication (stop at once) or the network (stop after repeats).
pub fn classify_push_failure(stderr: &str) -> PushFailure {
    if mentions(stderr, &REFUSED_FIRST) {
        return PushFailure::Rejected;
    }
    if mentions(stderr, &NETWORK_FAILURE) {
        PushFailure::Network
    } else {
        PushFailure::Rejected
    }
}

pub fn failure_name(failure: PushFailure) -> &'static str {
    match failure {
        PushFailure::Rejected => "rejected",
        PushFailure::Network => "network",
    }
}

/// The last three non-blank lines of `text` on one line, at most 300 characters.
pub fn brief(text: &str) -> String {
    let lines: Vec<&str> = text
        .split('\n')
        .map(|entry| entry.trim_matches(is_js_space))
        .filter(|entry| !entry.is_empty())
        .collect();
    let start = lines.len().saturating_sub(3);
    let line = lines[start..].join(" · ");
    let line = if line.is_empty() {
        "failed".to_owned()
    } else {
        line
    };
    let units: Vec<u16> = line.encode_utf16().collect();
    if units.len() > 300 {
        format!("{}...", String::from_utf16_lossy(&units[..297]))
    } else {
        line
    }
}

// ---- the queue --------------------------------------------------------------------------------------------------

/// One thing on the ship queue (`ShipQueueItem`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub id: String,
    pub kind: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
    /// `revert`: the cycle number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cycle: Option<i64>,
    pub at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// The run's worktree.
    pub root: String,
    /// The user's default checkout (where a merge lands).
    pub checkout_root: String,
    pub branch: String,
    /// Push `HEAD:<push_to>` instead of the branch itself (a run on its own branch off a target another worktree holds).
    #[serde(default)]
    pub push_to: Option<String>,
    pub base_branch: String,
    pub remote: String,
    /// The project's default branch a `land` item fast-forwards (Automatic shipping).
    #[serde(default)]
    pub land_to: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub kind: String,
    #[serde(default)]
    pub cycle: Option<i64>,
    #[serde(default)]
    pub sha: Option<String>,
    /// `merge`: also allow a merge commit when a fast-forward is not possible (`merge_commit`).
    #[serde(default)]
    pub mode: Option<String>,
    /// `land`: the command whose pass made the cycle green; a merge with a moved default branch is checked with it.
    #[serde(default)]
    pub check: Option<String>,
}

/// What a `land` did. `landed`: the default branch is now `sha` (or already was): the cycle's commit, or with `merge` the
/// commit that merged the default branch (`onto`) into it, which `check` passed on in a temporary checkout; `advanced`
/// says the run's own branch was fast-forwarded to it. `behind`: the default branch has commits the run lacks; nothing
/// moved; `conflicts` names the files a merge would conflict in (empty: a clean merge; none: git could not say). `red`:
/// the merge was clean but the check failed on it; nothing moved. `pr`: the remote refused the default branch
/// (protected), so the run's branch was pushed and one pull request opened (`created`) or updated.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LandOutcome {
    #[serde(rename_all = "camelCase")]
    Landed {
        sha: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        merge: Option<Merged>,
    },
    #[serde(rename_all = "camelCase")]
    Behind {
        ahead: Option<i64>,
        conflicts: Option<Vec<String>>,
    },
    #[serde(rename_all = "camelCase")]
    Red {
        candidate: String,
        onto: String,
        check: String,
        exit_code: Option<i32>,
        timed_out: bool,
        tail: String,
    },
    #[serde(rename_all = "camelCase")]
    Pr {
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        created: bool,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Merged {
    pub onto: String,
    pub check: String,
    pub advanced: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShipResult {
    pub item: QueueItem,
    /// A push that failed: a refusal (also authentication) stops the run, a network failure only after repeats.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<PushFailure>,
    /// The push ran and may have set the branch's upstream (a `git config` write the audit must allow).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pushed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub land: Option<LandOutcome>,
}

/// What a PR is made from.
#[derive(Debug, Clone, Serialize)]
pub struct PrInput {
    pub title: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    pub draft: bool,
}

/// What a ship queue needs of whoever owns it (the run, or a parity suite's stand-ins).
pub trait Hooks: Send + Sync {
    /// Journal a ref move the audit must allow (`modes.autopilot_ship_action`).
    fn journal(&self, action: Value) -> Fut<Result<(), String>>;
    /// The queue changed: broadcast it.
    fn changed(&self, queue: Vec<QueueItem>);
    /// A revert went through: mark the cycle (`modes.autopilot_mark_reverted`).
    fn reverted(&self, cycle: i64) -> Fut<Result<(), String>>;
    /// The pull request's title and body: the cycle log.
    fn pr_text(&self) -> Fut<Result<(String, String), String>>;
    fn pr_create(&self, cwd: String, input: PrInput) -> Fut<Result<(String, i64), String>>;
    /// A check of a land candidate when the owner brings its own (a parity suite's); none: the temporary checkout's.
    fn check_candidate(&self, _input: &CheckInput) -> Option<Fut<LandCheck>> {
        None
    }
}

pub type Accept = Arc<dyn Fn(&QueueItem) -> bool + Send + Sync>;

enum Failed {
    Failure(String, Option<PushFailure>),
    Stop(String, Box<LandOutcome>),
}

impl From<Fault> for Failed {
    fn from(fault: Fault) -> Failed {
        Failed::Failure(fault.message, None)
    }
}

fn failure(message: impl Into<String>) -> Failed {
    Failed::Failure(brief(&message.into()), None)
}

fn behind_detail(remote: &str, dest: &str, behind: &LandOutcome) -> String {
    let LandOutcome::Behind { ahead, conflicts } = behind else {
        return String::new();
    };
    let moved = match ahead {
        None => format!("{remote}/{dest} moved on"),
        Some(count) => format!(
            "{remote}/{dest} has {count} commit{} this run lacks",
            if *count == 1 { "" } else { "s" }
        ),
    };
    match conflicts {
        None => format!("{moved}; not landed: merge it first"),
        Some(files) if files.is_empty() => {
            format!("{moved}; not landed: it merges cleanly, merge it first")
        }
        Some(files) => {
            let listed = files.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
            let more = if files.len() > 5 {
                format!(" and {} more", files.len() - 5)
            } else {
                String::new()
            };
            format!("{moved}; not landed: a merge conflicts in {listed}{more}")
        }
    }
}

/// `stderr.replace(/^remote:\s*/gm, "")`.
fn without_remote_prefix(text: &str) -> String {
    let mut out = String::new();
    let mut at = 0;
    while at < text.len() {
        let line_start = at == 0 || text.as_bytes()[at - 1] == b'\n';
        if line_start && text[at..].starts_with("remote:") {
            at += "remote:".len();
            while let Some(c) = text[at..].chars().next().filter(|c| is_js_space(*c)) {
                at += c.len_utf8();
            }
            continue;
        }
        let c = text[at..].chars().next().unwrap_or_default();
        out.push(c);
        at += c.len_utf8();
    }
    out
}

/// `/https?:\/\/\S+\/pull\/\d+/` over `text`.
fn pull_request_url(text: &str) -> Option<String> {
    let mut from = 0;
    while let Some(found) = text[from..].find("http") {
        let start = from + found;
        from = start + 4;
        let rest = &text[start..];
        let scheme = if rest.starts_with("https://") {
            8
        } else if rest.starts_with("http://") {
            7
        } else {
            continue;
        };
        let run_end = rest.find(is_js_space).unwrap_or(rest.len());
        let run = &rest[..run_end];
        let mut search = run.len();
        while let Some(at) = run[..search].rfind("/pull/") {
            let digits = run[at + 6..]
                .chars()
                .take_while(char::is_ascii_digit)
                .count();
            if digits > 0 && at > scheme {
                return Some(run[..at + 6 + digits].to_owned());
            }
            search = at;
        }
    }
    None
}

fn dev_null() -> &'static str {
    if cfg!(windows) {
        "\\\\.\\nul"
    } else {
        "/dev/null"
    }
}

struct State {
    items: Vec<QueueItem>,
    modes: HashMap<String, String>,
    /// A land item's check command (what made its cycle green).
    checks: HashMap<String, String>,
    /// The pull request a protected default branch made landing open (one per run; later lands update its branch).
    land_pr: Option<Option<String>>,
}

/// Fails the running items of a drain whose caller was stopped before it ended.
struct FailRunningOnDrop {
    runner: Arc<ShipRunner>,
    armed: bool,
}

impl Drop for FailRunningOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.runner
                .fail_running("the step that held this drain was stopped, and the drain with it");
        }
    }
}

pub struct ShipRunner {
    hooks: Arc<dyn Hooks>,
    port: MainPort,
    state: Mutex<State>,
    chain: Steps,
    drain_max: Duration,
    stop_grace: Duration,
}

impl ShipRunner {
    pub fn new(
        port: MainPort,
        hooks: Arc<dyn Hooks>,
        drain_max: Duration,
        stop_grace: Duration,
    ) -> Arc<ShipRunner> {
        Arc::new(ShipRunner {
            hooks,
            port,
            state: Mutex::new(State {
                items: Vec::new(),
                modes: HashMap::new(),
                checks: HashMap::new(),
                land_pr: None,
            }),
            chain: Steps::new("autopilot ship queue", drain_max, None),
            drain_max,
            stop_grace,
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn queue(&self) -> Vec<QueueItem> {
        self.lock().items.clone()
    }

    /// Queue an item; it runs at the next `drain` (the end of the turn).
    pub fn enqueue(&self, request: &Request, id: String, at: i64) -> QueueItem {
        let item = QueueItem {
            id: id.clone(),
            kind: request.kind.clone(),
            state: "queued".into(),
            detail: None,
            url: None,
            sha: request.sha.clone().filter(|sha| !sha.is_empty()),
            cycle: request.cycle,
            at,
        };
        {
            let mut state = self.lock();
            if let Some(mode) = &request.mode {
                state.modes.insert(id.clone(), mode.clone());
            }
            if let Some(check) = request.check.clone().filter(|check| !check.is_empty()) {
                state.checks.insert(id, check);
            }
            state.items.push(item.clone());
        }
        self.broadcast();
        item
    }

    /// Show something the runner does not run (a release the agent performs).
    pub fn track(&self, detail: Option<String>, id: String, at: i64) -> QueueItem {
        let item = QueueItem {
            id,
            kind: "release".into(),
            state: "running".into(),
            detail: detail.filter(|detail| !detail.is_empty()),
            url: None,
            sha: None,
            cycle: None,
            at,
        };
        self.lock().items.push(item.clone());
        self.broadcast();
        item
    }

    /// Settle a tracked item.
    pub fn finish(&self, id: &str, state: &str, detail: Option<String>, url: Option<String>) {
        {
            let mut guard = self.lock();
            let Some(item) = guard.items.iter_mut().find(|entry| entry.id == id) else {
                return;
            };
            item.state = state.to_owned();
            if detail.is_some() {
                item.detail = detail;
            }
            if url.is_some() {
                item.url = url;
            }
        }
        self.broadcast();
    }

    /// Drop an item that has not started.
    pub fn cancel(&self, id: &str) -> bool {
        {
            let mut state = self.lock();
            let Some(at) = state
                .items
                .iter()
                .position(|entry| entry.id == id && entry.state == "queued")
            else {
                return false;
            };
            state.items.remove(at);
            state.modes.remove(id);
            state.checks.remove(id);
        }
        self.broadcast();
        true
    }

    pub fn close(&self) {
        self.chain.close();
        let mut state = self.lock();
        state.items.retain(|item| item.state != "queued");
        state.modes.clear();
        state.checks.clear();
    }

    pub async fn idle(&self) {
        self.chain.idle().await;
    }

    /// Whether a queued item is waiting.
    pub fn has_queued(&self) -> bool {
        self.lock().items.iter().any(|item| item.state == "queued")
    }

    fn broadcast(&self) {
        self.hooks.changed(self.queue());
    }

    fn update(&self, id: &str, change: impl FnOnce(&mut QueueItem)) {
        if let Some(item) = self.lock().items.iter_mut().find(|item| item.id == id) {
            change(item);
        }
    }

    fn detail(&self, id: &str, detail: String) {
        self.update(id, |item| item.detail = Some(detail));
    }

    fn prune(&self) {
        let mut state = self.lock();
        // The newest release stays however many pushes follow it: the screen shows the last release's outcome.
        let last_release = state
            .items
            .iter()
            .rposition(|entry| entry.kind == "release");
        let finished: Vec<usize> = state
            .items
            .iter()
            .enumerate()
            .filter(|(at, entry)| {
                (entry.state == "done" || entry.state == "failed") && Some(*at) != last_release
            })
            .map(|(at, _)| at)
            .collect();
        let stale = finished.len().saturating_sub(KEEP_FINISHED);
        for at in finished[..stale].iter().rev() {
            state.items.remove(*at);
        }
    }

    /// Run the queued items in order (items queued meanwhile too); with `accept`, only those it takes, the rest stay queued
    /// for a later drain. Drains never overlap. A drain that runs past its bound is stopped: the item it was running fails
    /// (its reason says so, the screen and the agent's note show it), what finished before it is returned, and the next
    /// drain starts.
    pub async fn drain(
        self: &Arc<Self>,
        target: Target,
        accept: Option<Accept>,
    ) -> Vec<ShipResult> {
        self.drain_within(target, accept, self.drain_max).await
    }

    /// `drain` with its own bound (the parity suites stop one drain at a short one and run the next at the full one).
    pub async fn drain_within(
        self: &Arc<Self>,
        target: Target,
        accept: Option<Accept>,
        max: Duration,
    ) -> Vec<ShipResult> {
        let results = Arc::new(Mutex::new(Vec::new()));
        let this = self.clone();
        let collected = results.clone();
        // A drain whose caller is stopped (the step that awaits it hit its bound) is stopped with it: its running item
        // fails now, instead of running on behind a step the run has left.
        let mut fence = FailRunningOnDrop {
            runner: self.clone(),
            armed: true,
        };
        let ended = self
            .chain
            .run("drain", Some(max), async move {
                this.drain_items(target, accept, collected).await;
            })
            .await;
        fence.armed = false;
        let mut results = results
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Ended::Stalled(stall) = ended {
            results.extend(self.fail_running(&stall.message()));
        }
        results
    }

    /// Every item that is running fails with `message`; what it did before is what the screen and the agent's note show.
    fn fail_running(&self, message: &str) -> Vec<ShipResult> {
        let mut failed = Vec::new();
        {
            let mut state = self.lock();
            for item in state.items.iter_mut() {
                if item.state != "running" || item.kind == "release" {
                    continue;
                }
                item.state = "failed".into();
                item.detail = Some(message.to_owned());
                failed.push(ShipResult {
                    item: item.clone(),
                    failure: None,
                    pushed: None,
                    land: None,
                });
            }
            for result in &failed {
                state.modes.remove(&result.item.id);
                state.checks.remove(&result.item.id);
            }
        }
        self.broadcast();
        failed
    }

    async fn drain_items(
        self: Arc<Self>,
        target: Target,
        accept: Option<Accept>,
        results: Arc<Mutex<Vec<ShipResult>>>,
    ) {
        loop {
            let item = {
                let mut state = self.lock();
                let found = state.items.iter_mut().find(|entry| {
                    entry.state == "queued" && accept.as_ref().is_none_or(|accept| accept(entry))
                });
                let Some(entry) = found else { break };
                entry.state = "running".into();
                entry.clone()
            };
            self.broadcast();
            let mut result = ShipResult {
                item: item.clone(),
                failure: None,
                pushed: None,
                land: None,
            };
            let done = match self.git().await {
                Ok(git) => self.run_item(&git, &target, &item, &mut result).await,
                Err(fault) => Err(fault.into()),
            };
            match done {
                Ok(()) => self.update(&item.id, |entry| entry.state = "done".into()),
                Err(error) => {
                    let (message, push, stop) = match error {
                        Failed::Failure(message, push) => (message, push, None),
                        Failed::Stop(message, outcome) => (message, None, Some(*outcome)),
                    };
                    self.update(&item.id, |entry| {
                        entry.state = "failed".into();
                        entry.detail = Some(brief(&message));
                    });
                    result.failure = push;
                    if stop.is_some() {
                        result.land = stop;
                    }
                }
            }
            {
                let mut state = self.lock();
                state.modes.remove(&item.id);
                state.checks.remove(&item.id);
            }
            result.item = self
                .lock()
                .items
                .iter()
                .find(|entry| entry.id == item.id)
                .cloned()
                .unwrap_or(item);
            results
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(result);
            self.prune();
            self.broadcast();
        }
    }

    async fn run_item(
        &self,
        git: &Git,
        target: &Target,
        item: &QueueItem,
        result: &mut ShipResult,
    ) -> Result<(), Failed> {
        match item.kind.as_str() {
            "push" => {
                self.push_pinned(git, target, &item.id).await?;
                result.pushed = Some(true);
            }
            "pr" => {
                let pushed = self.pr(git, target, &item.id).await?;
                result.pushed = pushed.then_some(true);
            }
            "merge" => self.merge(git, target, &item.id).await?,
            "land" => {
                let (land, pushed) = self.land(git, target, &item.id).await?;
                result.land = Some(land);
                result.pushed = pushed.then_some(true);
            }
            "revert" => self.revert(git, target, &item.id).await?,
            _ => {}
        }
        Ok(())
    }

    async fn git(&self) -> Result<Git, Fault> {
        super::git_from(&self.port).await
    }

    fn item(&self, id: &str) -> QueueItem {
        self.lock()
            .items
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .expect("a running item is on the queue")
    }

    async fn run(
        &self,
        git: &Git,
        cwd: &str,
        args: &[&str],
        env: &[(&str, &str)],
        timeout_ms: u64,
    ) -> Result<Output, Failed> {
        let opts = Opts {
            timeout_ms: Some(timeout_ms),
            env,
            ..Opts::default()
        };
        Ok(git.run(cwd, args, opts).await?)
    }

    async fn plain(&self, git: &Git, cwd: &str, args: &[&str]) -> Result<Output, Failed> {
        self.run(git, cwd, args, &[], GIT_TIMEOUT_MS).await
    }

    async fn text(&self, git: &Git, cwd: &str, args: &[&str]) -> Result<String, Failed> {
        let result = self.plain(git, cwd, args).await?;
        if result.code != 0 {
            return Err(failure(&result.stderr));
        }
        Ok(js_trim(&result.text()).to_owned())
    }

    /// The sha an item pins, or HEAD of the run's worktree now (pinned from then on).
    async fn pinned(&self, git: &Git, target: &Target, id: &str) -> Result<String, Failed> {
        if let Some(sha) = self.item(id).sha {
            return Ok(sha);
        }
        let sha = self.text(git, &target.root, &["rev-parse", "HEAD"]).await?;
        self.update(id, |item| item.sha = Some(sha.clone()));
        Ok(sha)
    }

    /// Push the sha pinned now to `refs/heads/<branch>` on the remote.
    async fn push_pinned(&self, git: &Git, target: &Target, id: &str) -> Result<(), Failed> {
        let remote = &target.remote;
        // The branch Push moves: the run's own, or the target the run works toward (fast-forward only either way).
        let dest = target.push_to.as_deref().unwrap_or(&target.branch);
        let sha = self.pinned(git, target, id).await?;
        let pushed = self.push_sha(git, target, &sha, dest).await?;
        if pushed.code != 0 {
            // A push is never forced: a remote branch that moved on stops the run, and the reason says so.
            let why = if mentions(&pushed.stderr, &MOVED_ON) {
                format!(
                    "{remote}/{dest} has commits this run lacks (not a fast-forward); Autopilot never forces a push. {}",
                    brief(&pushed.stderr)
                )
            } else {
                brief(&pushed.stderr)
            };
            let units: Vec<u16> = why.encode_utf16().collect();
            let why = if units.len() > 400 {
                format!("{}...", String::from_utf16_lossy(&units[..397]))
            } else {
                why
            };
            return Err(Failed::Failure(
                why,
                Some(classify_push_failure(&pushed.stderr)),
            ));
        }
        self.track_upstream(git, target, dest).await
    }

    /// `git push <remote> <sha>:refs/heads/<dest>`, journaled first, never forced.
    async fn push_sha(
        &self,
        git: &Git,
        target: &Target,
        sha: &str,
        dest: &str,
    ) -> Result<Output, Failed> {
        let (root, remote) = (&target.root, &target.remote);
        let url = self.text(git, root, &["remote", "get-url", remote]).await?;
        self.hooks
            .journal(json!({"kind": "push", "refs": [format!("refs/remotes/{remote}/{dest}")], "sha": sha}))
            .await
            .map_err(failure)?;
        let key = format!("remote.{remote}.pushurl");
        let refspec = format!("{sha}:refs/heads/{dest}");
        self.run(
            git,
            root,
            &["push", remote, &refspec],
            &[
                ("GIT_CONFIG_COUNT", "1"),
                ("GIT_CONFIG_KEY_0", &key),
                ("GIT_CONFIG_VALUE_0", &url),
            ],
            PUSH_TIMEOUT_MS,
        )
        .await
    }

    async fn track_upstream(&self, git: &Git, target: &Target, dest: &str) -> Result<(), Failed> {
        let (root, branch, remote) = (&target.root, &target.branch, &target.remote);
        let upstream = self
            .plain(
                git,
                root,
                &[
                    "rev-parse",
                    "--abbrev-ref",
                    &format!("{branch}@{{upstream}}"),
                ],
            )
            .await?;
        if upstream.code != 0 {
            self.plain(
                git,
                root,
                &[
                    "branch",
                    &format!("--set-upstream-to={remote}/{dest}"),
                    branch,
                ],
            )
            .await?;
        }
        Ok(())
    }

    /// Land the cycle's commit on the default branch. Fetch it; when the commit contains the remote's tip, push it there (a
    /// fast-forward). When the default branch moved on and merges cleanly (`git merge-tree`, no checkout), build the merge
    /// commit, run the cycle's check on exactly that commit in a temporary checkout, and push it only when the check passed
    /// and the default branch did not move meanwhile; a branch that moved again (during the check or the push) gets a new
    /// candidate, checked again, up to `LAND_ATTEMPTS` times. A merge that conflicts, a cycle without a known check, or a
    /// failed check is reported and nothing moves. A refusal that is not the branch moving on is a protected branch: the
    /// run's branch goes up instead, with one pull request into the default branch.
    async fn land(
        &self,
        git: &Git,
        target: &Target,
        id: &str,
    ) -> Result<(LandOutcome, bool), Failed> {
        let (root, remote) = (&target.root, &target.remote);
        let Some(dest) = target.land_to.as_deref() else {
            return Err(failure("The run has no default branch to land on."));
        };
        let sha = self.pinned(git, target, id).await?;
        let check = self.lock().checks.get(id).cloned();
        let mut attempt = 0;
        loop {
            attempt += 1;
            let tip = self.fetch_tip(git, target, dest).await?;
            if tip.as_deref() == Some(sha.as_str()) {
                self.detail(id, format!("{remote}/{dest} already has it"));
                return Ok((LandOutcome::Landed { sha, merge: None }, false));
            }
            let mut candidate = sha.clone();
            let mut merge: Option<(String, String)> = None;
            if let Some(tip) = &tip {
                let contains = self
                    .plain(git, root, &["merge-base", "--is-ancestor", tip, &sha])
                    .await?;
                if contains.code != 0 {
                    // A pull request already carries the run (the default branch refuses pushes): it takes the commit as it is.
                    if self.lock().land_pr.is_some() {
                        return self
                            .land_by_pr(
                                git,
                                target,
                                id,
                                &sha,
                                "the default branch refuses pushes".into(),
                            )
                            .await;
                    }
                    let behind = self.behind(git, root, tip, &sha).await?;
                    let clean = matches!(&behind, LandOutcome::Behind { conflicts: Some(files), .. } if files.is_empty());
                    let Some(check) = check.clone().filter(|_| clean) else {
                        let detail = behind_detail(remote, dest, &behind);
                        self.detail(id, detail.clone());
                        return Err(Failed::Stop(detail, Box::new(behind)));
                    };
                    candidate = self
                        .merge_commit(git, root, &sha, tip, &format!("{remote}/{dest}"))
                        .await?;
                    self.detail(
                        id,
                        format!(
                            "checking the merge with {remote}/{dest} ({})",
                            &candidate[..candidate.len().min(9)]
                        ),
                    );
                    self.broadcast();
                    let input = CheckInput {
                        root: root.clone(),
                        primary: target.checkout_root.clone(),
                        sha: candidate.clone(),
                        base: Some(tip.clone()),
                        command: check.clone(),
                        timeout_ms: None,
                    };
                    let checked = match self.hooks.check_candidate(&input) {
                        Some(custom) => custom.await,
                        None => {
                            land_check::check_candidate(
                                git,
                                &self.port,
                                &input,
                                self.stop_grace,
                                &super::steps::step_scope(),
                            )
                            .await
                        }
                    };
                    if !checked.ok {
                        let why = if checked.timed_out {
                            "timed out".to_owned()
                        } else {
                            format!(
                                "exit {}",
                                checked
                                    .exit_code
                                    .map_or("?".to_owned(), |code| code.to_string())
                            )
                        };
                        let detail = format!(
                            "the merge with {remote}/{dest} fails the check ({why}); not landed"
                        );
                        self.detail(id, detail.clone());
                        return Err(Failed::Stop(
                            detail,
                            Box::new(LandOutcome::Red {
                                candidate,
                                onto: tip.clone(),
                                check,
                                exit_code: checked.exit_code,
                                timed_out: checked.timed_out,
                                tail: checked.tail,
                            }),
                        ));
                    }
                    if self.fetch_tip(git, target, dest).await?.as_deref() != Some(tip.as_str()) {
                        if attempt < LAND_ATTEMPTS {
                            continue;
                        }
                        return Err(self.kept_moving(target, id, dest));
                    }
                    merge = Some((tip.clone(), check));
                }
            }
            let pushed = self.push_sha(git, target, &candidate, dest).await?;
            if pushed.code == 0 {
                let detail = match &merge {
                    Some((onto, _)) => format!(
                        "{remote}/{dest} (merged with {}, checked)",
                        &onto[..onto.len().min(9)]
                    ),
                    None => format!("{remote}/{dest}"),
                };
                self.detail(id, detail);
                let Some((onto, check)) = merge else {
                    return Ok((LandOutcome::Landed { sha, merge: None }, true));
                };
                let advanced = self.advance(git, root, &sha, &candidate).await?;
                return Ok((
                    LandOutcome::Landed {
                        sha: candidate,
                        merge: Some(Merged {
                            onto,
                            check,
                            advanced,
                        }),
                    },
                    true,
                ));
            }
            if mentions(&pushed.stderr, &MOVED_ON) {
                // The default branch moved between the fetch and the push: measure it again.
                if attempt < LAND_ATTEMPTS {
                    continue;
                }
                return Err(self.kept_moving(target, id, dest));
            }
            let kind = classify_push_failure(&pushed.stderr);
            if kind == PushFailure::Network || mentions(&pushed.stderr, &NOT_ALLOWED_AT_ALL) {
                return Err(Failed::Failure(brief(&pushed.stderr), Some(kind)));
            }
            // The remote's own words say why (a branch rule, a hook); git's trailer only says that it refused.
            let said = pushed
                .stderr
                .split('\n')
                .filter(|line| line.starts_with("remote:"))
                .collect::<Vec<_>>()
                .join("\n");
            let stripped = without_remote_prefix(&said);
            let reason = brief(if stripped.is_empty() {
                &pushed.stderr
            } else {
                &stripped
            });
            return self.land_by_pr(git, target, id, &sha, reason).await;
        }
    }

    fn kept_moving(&self, target: &Target, id: &str, dest: &str) -> Failed {
        let behind = LandOutcome::Behind {
            ahead: None,
            conflicts: None,
        };
        let detail = format!(
            "{} (it kept moving: {LAND_ATTEMPTS} tries)",
            behind_detail(&target.remote, dest, &behind)
        );
        self.detail(id, detail.clone());
        Failed::Stop(detail, Box::new(behind))
    }

    /// Fetch the default branch into its remote-tracking ref; its tip, or none when the remote has no such branch.
    async fn fetch_tip(
        &self,
        git: &Git,
        target: &Target,
        dest: &str,
    ) -> Result<Option<String>, Failed> {
        let (root, remote) = (&target.root, &target.remote);
        let tracking = format!("refs/remotes/{remote}/{dest}");
        let refspec = format!("+refs/heads/{dest}:{tracking}");
        let fetched = self
            .run(
                git,
                root,
                &["fetch", "--no-tags", remote, &refspec],
                &[],
                PUSH_TIMEOUT_MS,
            )
            .await?;
        if fetched.code != 0
            && !fetched
                .stderr
                .to_lowercase()
                .contains("couldn't find remote ref")
        {
            return Err(Failed::Failure(
                brief(&fetched.stderr),
                Some(classify_push_failure(&fetched.stderr)),
            ));
        }
        let tip = self
            .plain(git, root, &["rev-parse", "--verify", "-q", &tracking])
            .await?;
        Ok((tip.code == 0).then(|| js_trim(&tip.text()).to_owned()))
    }

    /// The merge of `tip` into `sha` as a commit object (`sha` first parent), built without any checkout or ref.
    async fn merge_commit(
        &self,
        git: &Git,
        root: &str,
        sha: &str,
        tip: &str,
        name: &str,
    ) -> Result<String, Failed> {
        let tree = self
            .text(
                git,
                root,
                &["merge-tree", "--write-tree", "--no-messages", sha, tip],
            )
            .await?;
        let short = self.text(git, root, &["rev-parse", "--short", sha]).await?;
        let message = format!("Merge {name} into {short} (Autopilot land)");
        let tree = tree.split('\n').next().unwrap_or(&tree);
        self.text(
            git,
            root,
            &[
                "commit-tree",
                "--no-gpg-sign",
                tree,
                "-p",
                sha,
                "-p",
                tip,
                "-m",
                &message,
            ],
        )
        .await
    }

    /// Fast-forward the run's branch to the landed merge, only while its worktree still sits on the cycle's commit with
    /// nothing changed (the agent has not moved on); no hook runs. False: left as it was.
    async fn advance(&self, git: &Git, root: &str, from: &str, to: &str) -> Result<bool, Failed> {
        let head = self.plain(git, root, &["rev-parse", "HEAD"]).await?;
        if head.code != 0 || js_trim(&head.text()) != from {
            return Ok(false);
        }
        let status = self.plain(git, root, &["status", "--porcelain"]).await?;
        if status.code != 0 || !js_trim(&status.text()).is_empty() {
            return Ok(false);
        }
        let hooks = format!("core.hooksPath={}", dev_null());
        let merged = self
            .plain(git, root, &["-c", &hooks, "merge", "--ff-only", "-q", to])
            .await?;
        Ok(merged.code == 0)
    }

    /// The default branch refused the push: the run's branch goes up and one pull request into the default branch carries it.
    async fn land_by_pr(
        &self,
        git: &Git,
        target: &Target,
        id: &str,
        sha: &str,
        reason: String,
    ) -> Result<(LandOutcome, bool), Failed> {
        let (branch, remote) = (&target.branch, &target.remote);
        let dest = target.land_to.as_deref().unwrap_or(&target.base_branch);
        let pushed = self.push_sha(git, target, sha, branch).await?;
        if pushed.code != 0 {
            return Err(Failed::Failure(
                brief(&pushed.stderr),
                Some(classify_push_failure(&pushed.stderr)),
            ));
        }
        self.track_upstream(git, target, branch).await?;
        let created = self.lock().land_pr.is_none();
        if created {
            let (title, body) = self.hooks.pr_text().await.map_err(failure)?;
            let input = PrInput {
                title,
                body,
                base: Some(dest.to_owned()),
                head: Some(branch.clone()),
                draft: false,
            };
            match self.hooks.pr_create(target.root.clone(), input).await {
                Ok((url, _)) => self.lock().land_pr = Some(Some(url)),
                Err(text) => {
                    // A pull request from this branch exists already (an earlier launch opened it): that one carries the work.
                    if !text.to_lowercase().contains("already exists") {
                        return Err(failure(text));
                    }
                    self.lock().land_pr = Some(pull_request_url(&text));
                }
            }
        }
        let url = self.lock().land_pr.clone().flatten();
        self.update(id, |item| {
            item.detail = Some(format!(
                "{remote}/{dest} refused the push; {remote}/{branch} carries it"
            ));
            if let Some(url) = &url {
                item.url = Some(url.clone());
            }
        });
        Ok((
            LandOutcome::Pr {
                url,
                created,
                reason,
            },
            true,
        ))
    }

    /// How far the default branch moved past the run, and what a merge of it would conflict in.
    async fn behind(
        &self,
        git: &Git,
        root: &str,
        tip: &str,
        sha: &str,
    ) -> Result<LandOutcome, Failed> {
        let range = format!("{sha}..{tip}");
        let count = self
            .plain(git, root, &["rev-list", "--count", &range])
            .await?;
        let ahead = (count.code == 0).then(|| {
            let text = count.text();
            let text = js_trim(&text);
            if text.is_empty() {
                Some(0)
            } else {
                text.parse::<i64>().ok()
            }
        });
        let merged = self
            .plain(
                git,
                root,
                &[
                    "merge-tree",
                    "--write-tree",
                    "--name-only",
                    "--no-messages",
                    sha,
                    tip,
                ],
            )
            .await?;
        // Exit 0: a clean merge; 1: conflicts, the files after the tree line; anything else: git could not say.
        let conflicts = match merged.code {
            0 => Some(Vec::new()),
            1 => Some(
                js_trim(&merged.text())
                    .split('\n')
                    .skip(1)
                    .filter(|line| !line.is_empty())
                    .map(str::to_owned)
                    .collect(),
            ),
            _ => None,
        };
        Ok(LandOutcome::Behind {
            ahead: ahead.flatten(),
            conflicts,
        })
    }

    /// The PR's head is the branch Push moves: the run's own, or the target it works toward (`push_to`), the only branch
    /// Autopilot ever pushes. The work branch is not pushed for it. A head that is the base has nothing to compare.
    async fn pr(&self, git: &Git, target: &Target, id: &str) -> Result<bool, Failed> {
        let (root, remote, base) = (&target.root, &target.remote, &target.base_branch);
        let head = target.push_to.as_deref().unwrap_or(&target.branch);
        if head == base {
            return Err(failure(format!(
                "{head} is the base branch: there is nothing to open a pull request for."
            )));
        }
        let sha = self.text(git, root, &["rev-parse", "HEAD"]).await?;
        let tracked = self
            .plain(
                git,
                root,
                &[
                    "rev-parse",
                    "--verify",
                    "-q",
                    &format!("refs/remotes/{remote}/{head}"),
                ],
            )
            .await?;
        let on_remote = tracked.code == 0 && js_trim(&tracked.text()) == sha;
        if !on_remote {
            self.push_pinned(git, target, id).await?;
        }
        let (title, body) = self.hooks.pr_text().await.map_err(failure)?;
        let input = PrInput {
            title,
            body,
            base: Some(base.clone()),
            head: Some(head.to_owned()),
            draft: true,
        };
        let (url, number) = self
            .hooks
            .pr_create(root.clone(), input)
            .await
            .map_err(failure)?;
        self.update(id, |item| {
            item.url = Some(url);
            item.detail = Some(format!("#{number}"));
        });
        Ok(!on_remote)
    }

    async fn merge(&self, git: &Git, target: &Target, id: &str) -> Result<(), Failed> {
        let (root, checkout, base) = (&target.root, &target.checkout_root, &target.base_branch);
        let current = self
            .plain(git, checkout, &["symbolic-ref", "--short", "-q", "HEAD"])
            .await?;
        let on_branch = if current.code == 0 {
            js_trim(&current.text()).to_owned()
        } else {
            String::new()
        };
        if &on_branch != base {
            let name = if on_branch.is_empty() {
                "a detached HEAD"
            } else {
                &on_branch
            };
            return Err(failure(format!(
                "The default checkout is on {name}, not {base}."
            )));
        }
        let dirty = self
            .text(
                git,
                checkout,
                &["status", "--porcelain", "--untracked-files=no"],
            )
            .await?;
        if !dirty.is_empty() {
            return Err(failure(
                "The default checkout has uncommitted changes; it must be clean to merge.",
            ));
        }
        let sha = self.pinned(git, target, id).await?;
        let _ = root;
        self.hooks
            .journal(json!({"kind": "merge", "refs": [format!("refs/heads/{base}")], "sha": sha}))
            .await
            .map_err(failure)?;
        let fast = self
            .plain(git, checkout, &["merge", "--ff-only", &sha])
            .await?;
        if fast.code == 0 {
            return Ok(());
        }
        if self.lock().modes.get(id).map(String::as_str) != Some("merge_commit") {
            return Err(failure(format!(
                "{base} cannot fast-forward to this branch: {}",
                brief(&fast.stderr)
            )));
        }
        let merged = self
            .plain(git, checkout, &["merge", "--no-ff", "--no-edit", &sha])
            .await?;
        if merged.code == 0 {
            return Ok(());
        }
        self.plain(git, checkout, &["merge", "--abort"]).await?;
        let said = if merged.text().is_empty() {
            merged.stderr.clone()
        } else {
            merged.text()
        };
        Err(failure(format!(
            "The merge conflicted and was aborted: {}",
            brief(&said)
        )))
    }

    async fn revert(&self, git: &Git, target: &Target, id: &str) -> Result<(), Failed> {
        let root = &target.root;
        let item = self.item(id);
        let Some(sha) = item.sha else {
            return Err(failure("That cycle has no commit to revert."));
        };
        let parents = self
            .plain(git, root, &["rev-list", "--parents", "-n", "1", &sha])
            .await?;
        if parents.code != 0 {
            return Err(failure(brief(&parents.stderr)));
        }
        let merge = js_trim(&parents.text()).split_whitespace().count() > 2;
        self.hooks
            .journal(json!({"kind": "revert", "refs": [], "sha": sha}))
            .await
            .map_err(failure)?;
        let mut args = vec!["revert", "--no-edit"];
        if merge {
            args.extend(["-m", "1"]);
        }
        args.push(&sha);
        let reverted = self.plain(git, root, &args).await?;
        if reverted.code != 0 {
            self.plain(git, root, &["revert", "--abort"]).await?;
            let said = if reverted.text().is_empty() {
                reverted.stderr.clone()
            } else {
                reverted.text()
            };
            return Err(failure(format!(
                "The revert conflicted and was aborted: {}",
                brief(&said)
            )));
        }
        if let Some(cycle) = item.cycle {
            self.hooks.reverted(cycle).await.map_err(failure)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn captured() -> Value {
        serde_json::from_str(include_str!("captured-ship.json")).unwrap()
    }

    #[test]
    fn failures_are_classified_as_the_typescript_did() {
        for case in captured()["classify"].as_array().unwrap() {
            let out = failure_name(classify_push_failure(case["input"].as_str().unwrap()));
            assert_eq!(json!(out), case["out"], "{}", case["input"]);
        }
    }

    #[test]
    fn a_brief_is_the_last_three_lines_in_at_most_300_characters() {
        for case in captured()["brief"].as_array().unwrap() {
            assert_eq!(
                brief(case["input"].as_str().unwrap()),
                case["out"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn a_land_that_fell_behind_says_how_far_and_where() {
        for case in captured()["behind"].as_array().unwrap() {
            let outcome = &case["outcome"];
            let parsed = match outcome["kind"].as_str().unwrap() {
                "behind" => LandOutcome::Behind {
                    ahead: outcome["ahead"].as_i64(),
                    conflicts: outcome["conflicts"].as_array().map(|files| {
                        files
                            .iter()
                            .map(|file| file.as_str().unwrap().to_owned())
                            .collect()
                    }),
                },
                _ => LandOutcome::Landed {
                    sha: "x".into(),
                    merge: None,
                },
            };
            let out = behind_detail(
                case["remote"].as_str().unwrap(),
                case["dest"].as_str().unwrap(),
                &parsed,
            );
            assert_eq!(out, case["out"].as_str().unwrap(), "{case}");
        }
    }

    #[test]
    fn a_remote_trailer_and_a_pull_request_link_are_read_out_of_git_s_words() {
        assert_eq!(
            without_remote_prefix("remote: Protected branch\nremote:   hook declined"),
            "Protected branch\nhook declined"
        );
        assert_eq!(without_remote_prefix("a remote: b"), "a remote: b");
        assert_eq!(
            pull_request_url("a pull request already exists: https://github.com/o/r/pull/12 for x")
                .as_deref(),
            Some("https://github.com/o/r/pull/12")
        );
        assert_eq!(pull_request_url("no link here"), None);
        assert_eq!(pull_request_url("http://x/pull/"), None);
    }
}
