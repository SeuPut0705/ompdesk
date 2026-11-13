//! A run's life after its start (was the rest of `src/main/autopilot.ts`): a cycle's end (children, audit, ship), stops and
//! resumes, the nudge, the quota wait, children, the release run and the run's summary.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Value, json};

use super::audit::{self, Scope};
use super::coordinator::{Coordinator, locked};
use super::run::{Child, ChildRun, Run, Settings};
use super::ship::{self, Accept, QueueItem, Request, ShipResult};
use super::start::{RELEASE_NOW_MESSAGE, STOP_AFTER_SHIP_NOTE};
use super::util::{Oops, R, after, every, flag, number, oops, short, text};
use crate::fs::order::js_trim;
use crate::git::run::Git;
use crate::run::Opts;

const GIT_MS: u64 = 30_000;
const STOP_AFTER_SHIP_CANCELLED: &str =
    "The person cancelled 'ship, then stop': the run goes on as before.";

/// What a nudge asks the quiet run for, by why it went quiet: the agent is told the reason, so a run whose items are all
/// blocked picks another instead of waiting on them again. Idea after OpenRig's reason-tagged wake messages.
pub fn nudge_message(reason: &str) -> &'static str {
    match reason {
        "plan" => {
            "Autopilot: plan mode stopped the run and is off now; nobody approves plans here. Call `autopilot begin` and continue with the next cycle."
        }
        "blocked" => {
            "Autopilot: every todo item is blocked, so the run stopped. If a cycle is open, end it with each blocker as a follow-up; then call `autopilot begin` and pick an item that is not blocked."
        }
        "error" => {
            "Autopilot: the last turn failed and nothing retried it. Call `autopilot begin` and continue; repeat the failed step only if the failure looks transient, otherwise record it as a follow-up and pick another item."
        }
        _ => {
            "Autopilot: no cycle is running. Call `autopilot begin` and continue with the next cycle."
        }
    }
}

/// Why each pause or end reads as it does (`REASON_TEXT`).
fn reason_key(reason: &str) -> Option<&'static str> {
    Some(match reason {
        "ban_violation" => "autopilot.reason.ban_violation",
        "repo_gone" => "autopilot.reason.repo_gone",
        "budget" => "autopilot.reason.budget",
        "time" => "autopilot.reason.time",
        "cycles" => "autopilot.reason.cycles",
        "cost" => "autopilot.reason.cost",
        "app_closed" => "autopilot.reason.app_closed",
        "agent_done" => "autopilot.reason.agent_done",
        "user" => "autopilot.reason.user",
        "user_pause" => "autopilot.reason.user_pause",
        "user_abort" => "autopilot.reason.user_abort",
        "tab_closed" => "autopilot.reason.tab_closed",
        _ => return None,
    })
}

/// Pauses that are the user's own doing, or a state the screen already shows: no notification.
const SILENT_REASONS: [&str; 4] = ["user_pause", "user_abort", "app_closed", "tab_closed"];
/// Pauses that are an outcome the user asked for (a ceiling they set) rather than a failure.
const COMPLETION_REASONS: [&str; 6] = ["budget", "time", "cycles", "cost", "agent_done", "user"];

/// What git says of a run's worktree: `present`, `gone` (the folder is missing, or git answers it is no repository) or
/// `unknown` (git did not answer: a timeout, a lock, a spawn failure, any other error).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepoProbe {
    Present,
    Gone,
    Unknown,
}

/// Why a cycle's work did not ship, or none when it did: green with a commit, and every push or land this cycle queued went
/// through (a land the default branch refused for a pull request counts: that pull request is where it ships). With nothing
/// queued (no remote), the green commit is all there is to ship.
pub fn ship_gap(record: &Value, results: &[ShipResult], own: &[String]) -> Option<String> {
    let verify = text(record, "verify").unwrap_or("undefined");
    if verify != "green" {
        return Some(format!("its check was {verify}"));
    }
    if text(record, "commit").is_none_or(str::is_empty) {
        return Some("it made no commit".into());
    }
    for id in own {
        let Some(result) = results.iter().find(|entry| &entry.item.id == id) else {
            return Some("its push did not run".into());
        };
        if result.item.kind == "land" {
            let kind = match &result.land {
                Some(ship::LandOutcome::Landed { .. }) => Some("landed"),
                Some(ship::LandOutcome::Pr { .. }) => Some("pr"),
                Some(ship::LandOutcome::Behind { .. }) => Some("behind"),
                Some(ship::LandOutcome::Red { .. }) => Some("red"),
                None => None,
            };
            if !matches!(kind, Some("landed" | "pr")) {
                return Some(format!(
                    "its land did not go through ({})",
                    kind.unwrap_or(&result.item.state)
                ));
            }
        } else if result.item.state != "done" {
            return Some(format!("its {} failed", result.item.kind));
        }
    }
    None
}

fn slow() -> Opts<'static> {
    Opts {
        timeout_ms: Some(GIT_MS),
        ..Opts::default()
    }
}

fn random_id() -> String {
    let mut bytes = [0u8; 4];
    let _ = crate::sys::random(&mut bytes);
    format!(
        "ship-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

impl Coordinator {
    // ---- main's events ----------------------------------------------------------------------------------------

    /// The bridge's cycle end, stop request and settled frames.
    pub fn frame(self: &Arc<Self>, tab: &str, frame: &Value) {
        let Some(run) = self.runs_get(tab) else {
            return;
        };
        let this = self.clone();
        match text(frame, "type") {
            Some("autopilot_cycle_end") => {
                let record = frame.get("record").cloned().unwrap_or(Value::Null);
                let received_at = self.now();
                self.title_by_item(&run, text(&record, "title"));
                let max = Some(Duration::from_millis(self.tuning.cycle_end_max_ms));
                let again = run.clone();
                self.enqueue(&run, "cycle end", max, async move {
                    this.cycle_end(&again, &record, received_at).await
                });
            }
            Some("autopilot_nudge") => {
                let reason = text(frame, "reason").unwrap_or("no_progress").to_owned();
                let again = run.clone();
                self.enqueue(&run, "nudge", None, async move {
                    this.nudge(&again, &reason).await
                });
            }
            Some("autopilot_stop_requested") => {
                let request = frame.clone();
                let again = run.clone();
                self.enqueue(&run, "stop", None, async move {
                    this.stop_requested(&again, &request).await
                });
            }
            Some("autopilot_settled") => {
                let reason = text(frame, "reason").unwrap_or_default().to_owned();
                let again = run.clone();
                self.enqueue(&run, "settle", None, async move {
                    this.settled(&again, &reason).await
                });
            }
            _ => {}
        }
    }

    /// The pool released the tab (closed by the user, or by us).
    pub fn tab_released(self: &Arc<Self>, tab: &str) {
        if let Some(end) = locked(&self.start_waits).remove(tab) {
            let _ = end.send("The Autopilot tab is gone.".to_owned());
        }
        if locked(&self.child_runs).remove(tab).is_some() {
            self.touch_child(tab, None);
        }
        locked(&self.awaiting_resume).remove(tab);
        locked(&self.continued_on_ready).remove(tab);
        let Some(run) = locked(&self.runs).remove(tab) else {
            return;
        };
        self.port.tell("mirror", &json!({"tab": tab, "gone": true}));
        let (polling, wake, children) = {
            let mut state = run.lock();
            (
                state.stop_polling.take(),
                state.quota_wake.take(),
                state
                    .children
                    .iter()
                    .map(|child| child.tab.clone())
                    .collect::<Vec<_>>(),
            )
        };
        if let Some(cancel) = polling {
            cancel.cancel();
        }
        if let Some(cancel) = wake {
            cancel.cancel();
        }
        for child in children {
            locked(&self.child_runs).remove(&child);
            self.touch_child(&child, None);
            let (this, port) = (self.clone(), self.port.clone());
            self.track(async move {
                let _ = port
                    .ask::<Value, _>("release", &json!({"tab": child}))
                    .await;
                drop(this);
            });
        }
    }

    /// A failed turn that neither stock's auto-retry nor TurnResume's scheduled retries will take up (they are spent) gets a
    /// nudge for the next cycle, never a pause. A usage limit waits here (`wait_for_quota`): journaled `waiting_quota` with
    /// its reset, woken at it.
    pub fn activity(self: &Arc<Self>, tab: &str, kind: &str) {
        let Some(run) = self.runs_get(tab) else {
            return;
        };
        let (this, again) = (self.clone(), run.clone());
        let grace = self.tuning.error_grace_ms;
        if kind == "limit" {
            // Stock's own auto-retry may still take it: look once it has had the chance, as for any other failure.
            after(grace, move || {
                let (co, target) = (this.clone(), again.clone());
                this.enqueue(&again, "quota wait", None, async move {
                    co.wait_for_quota(&target).await
                });
            });
        } else {
            // TurnResume arms its retry a moment after the failure is reported: look again once it has had the chance (the
            // nudge itself asks nothing while a retry, a turn or the connection wait holds the run).
            after(grace, move || {
                let (co, target) = (this.clone(), again.clone());
                this.enqueue(&again, "nudge", None, async move {
                    co.nudge(&target, "error").await
                });
            });
        }
    }

    // ---- the repository ---------------------------------------------------------------------------------------

    async fn probe_repo(&self, root: &str) -> RepoProbe {
        if self.probe_override {
            return match self
                .port
                .ask::<String, _>("probeRepo", &json!({"root": root}))
                .await
                .as_deref()
            {
                Ok("present") => RepoProbe::Present,
                Ok("gone") => RepoProbe::Gone,
                _ => RepoProbe::Unknown,
            };
        }
        match self.git().await {
            Ok(git) => probe(&git, root).await,
            Err(_) => RepoProbe::Unknown,
        }
    }

    /// `gone` only when two probes `repo_recheck_ms` apart both say so; `unknown` when git could not answer.
    async fn repo_state(&self, root: &str) -> RepoProbe {
        let first = self.probe_repo(root).await;
        if first != RepoProbe::Gone {
            return first;
        }
        tokio::time::sleep(Duration::from_millis(self.tuning.repo_recheck_ms)).await;
        self.probe_repo(root).await
    }

    // ---- a cycle's end: children, audit, ship ---------------------------------------------------------------

    async fn cycle_end(
        self: &Arc<Self>,
        run: &Arc<Run>,
        record: &Value,
        received_at: i64,
    ) -> R<()> {
        // The repository vanishing is one of the few stops left: nothing can be committed or audited without it. Only a
        // confirmed loss pauses; a git that cannot answer this time (a lock, a timeout, a load spike) skips this cycle's
        // audit and shipping, and the next cycle end checks again against the same snapshot.
        let root = run.lock().root.clone();
        match self.repo_state(&root).await {
            RepoProbe::Gone => return self.pause(run, "repo_gone", Some(&root)).await,
            RepoProbe::Unknown => {
                let n = number(record, "n").map_or("undefined".to_owned(), |n| n.to_string());
                self.log(&format!(
                    "{}: git did not answer at cycle {n}'s end; its audit and shipping wait for the next",
                    run.tab
                ));
                return Ok(());
            }
            RepoProbe::Present => {}
        }
        self.close_children(run, number(record, "n").unwrap_or(0))
            .await;
        let requests = match self
            .bridge(
                &run.tab,
                &self.contracts.bridge.take_ship_requests,
                json!({}),
                None,
            )
            .await
        {
            Ok(taken) => taken
                .get("requests")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            Err(error) => {
                self.log(&format!("ship requests: {}", error.message));
                Vec::new()
            }
        };
        let kinds: Vec<&str> = requests
            .iter()
            .filter_map(|request| text(request, "kind"))
            .collect();
        if kinds.contains(&"release") {
            run.lock().release_requested = true;
            self.touch(run);
        }
        let violations = self.audit(run).await?;
        if !violations.is_empty() {
            return self.violation(run, &violations).await;
        }
        run.lock().release_requested = false;
        self.touch(run);
        if let Some(ship) = record.get("ship").filter(|ship| !ship.is_null()) {
            self.release_reported(run, ship).await;
        }
        let wants_push = kinds.contains(&"push");
        let green = text(record, "verify") == Some("green");
        let (auto_push, land) = {
            let state = run.lock();
            (state.settings.auto_push() && green, state.settings.land())
        };
        let queued = |kind: &str| {
            run.ship
                .queue()
                .iter()
                .any(|item| item.kind == kind && item.state == "queued")
        };
        let mut own: Vec<String> = Vec::new();
        let commit = text(record, "commit")
            .filter(|commit| !commit.is_empty())
            .map(str::to_owned);
        if (wants_push || auto_push) && !queued("push") {
            // Pinned to the cycle's own commit: this push may run after a later turn has moved HEAD.
            let request = Request {
                kind: "push".into(),
                cycle: None,
                sha: commit.clone(),
                mode: None,
                check: None,
            };
            own.push(run.ship.enqueue(&request, random_id(), self.now()).id);
        }
        // Automatic shipping: only a green cycle with a commit of its own lands; a red one or one without a commit never. Its
        // check command goes along: a default branch that moved on is merged and that merge checked before it lands.
        if land && green && commit.is_some() && !queued("land") {
            let request = Request {
                kind: "land".into(),
                cycle: None,
                sha: commit.clone(),
                mode: None,
                check: text(record, "checkCommand")
                    .filter(|check| !check.is_empty())
                    .map(str::to_owned),
            };
            own.push(run.ship.enqueue(&request, random_id(), self.now()).id);
        }
        // This pipeline can outlive the next cycle's start: what the user queued after the frame arrived waits for that
        // turn's end; everything queued before it, and this cycle's own push and land, go now.
        let ids = own.clone();
        let accept: Accept =
            Arc::new(move |item: &QueueItem| ids.contains(&item.id) || item.at <= received_at);
        let results = self.drain(run, Some(accept)).await;
        // "Ship, then stop": a cycle that began after the choice ends the run only once its work shipped. One that did not
        // (red, no commit, a refused push, a land the default branch did not take) leaves the choice on, and the next cycle is
        // told to repair and ship it.
        let (end_after, waits_item, owed) = {
            let state = run.lock();
            (
                state.end_after_ship,
                state.release_item.is_some(),
                state.release_owed,
            )
        };
        if let Some(chosen) = end_after
            && number(record, "startedAt").unwrap_or(0) >= chosen
        {
            let unshipped = ship_gap(record, &results, &own);
            match unshipped {
                None if waits_item => {
                    // Its release run is still going: the run ends once it succeeds (`check_release`).
                    run.lock().ship_stop_waits_release = true;
                }
                None if owed => {
                    self.tell_agent(run, "Ship, then stop is still on: the release since the choice failed. Fix it and release again in the next cycle; the run stops once a release has succeeded.".into()).await;
                }
                None => {
                    run.lock().end_after_ship = None;
                    self.touch(run);
                    self.begin_stop(run, "user").await;
                }
                Some(gap) => {
                    self.tell_agent(
                        run,
                        format!("Ship, then stop is still on: this cycle did not ship ({gap}). Repair it in the next cycle, commit, and end it green; the run stops once that work has landed."),
                    )
                    .await;
                }
            }
        }
        Ok(())
    }

    async fn audit(&self, run: &Arc<Run>) -> R<Vec<audit::Violation>> {
        let git = self.git().await?;
        let (root, checkout, before) = {
            let state = run.lock();
            (
                state.root.clone(),
                state.checkout_root.clone(),
                state.snapshot.clone(),
            )
        };
        let Some(before) = before else {
            let snapshot = audit::take_snapshot(&git, &root, Some(&checkout))
                .await
                .ok();
            run.lock().snapshot = snapshot;
            return Ok(Vec::new());
        };
        let Ok(after) = audit::take_snapshot(&git, &root, Some(&checkout)).await else {
            return Ok(Vec::new());
        };
        let scope = {
            let state = run.lock();
            let in_flight_release = state
                .status
                .as_ref()
                .and_then(|status| status.get("ship"))
                .and_then(|ship| ship.get("inFlight"))
                .and_then(|flight| text(flight, "kind"))
                == Some("release");
            Scope {
                branch: state.branch.clone(),
                child_branches: state.child_branches.iter().cloned().collect(),
                remote: state.settings.remote(),
                default_branch: state.base_branch.clone(),
                release: state.settings.auto_release()
                    || state.release_requested
                    || in_flight_release,
                expected_refs: state.expected_refs.clone(),
                checkout_may_move: state.checkout_may_move,
                config_may_change: state.config_may_change,
            }
        };
        let violations = audit::audit_cycle(&git, &root, &before, &after, &scope).await?;
        let mut state = run.lock();
        state.snapshot = Some(after);
        state.expected_refs.clear();
        state.checkout_may_move = false;
        state.config_may_change = false;
        Ok(violations)
    }

    async fn violation(self: &Arc<Self>, run: &Arc<Run>, violations: &[audit::Violation]) -> R<()> {
        let detail = violations
            .iter()
            .map(|violation| violation.detail.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        self.log(&format!("ban violation in {}: {detail}", run.tab));
        self.pause(run, "ban_violation", Some(&detail)).await
    }

    /// Run the ShipRunner's queue; a refused or repeatedly unreachable push stops the run.
    async fn drain(self: &Arc<Self>, run: &Arc<Run>, accept: Option<Accept>) -> Vec<ShipResult> {
        let waiting: Vec<QueueItem> = run
            .ship
            .queue()
            .into_iter()
            .filter(|item| {
                item.state == "queued" && accept.as_ref().is_none_or(|accept| accept(item))
            })
            .collect();
        if waiting.is_empty() {
            return Vec::new();
        }
        let pushing = waiting
            .iter()
            .any(|item| matches!(item.kind.as_str(), "push" | "pr" | "land"));
        if pushing {
            let _ = self
                .set_state(
                    run,
                    json!({"inFlight": {"kind": "push", "startedAt": self.now()}}),
                )
                .await;
        }
        let target = {
            let state = run.lock();
            ship::Target {
                root: state.root.clone(),
                checkout_root: state.checkout_root.clone(),
                branch: state.branch.clone(),
                push_to: state.target.clone(),
                base_branch: state.base_branch.clone(),
                remote: state.settings.remote(),
                land_to: state.land_to.clone(),
            }
        };
        let results = run.ship.drain(target, accept).await;
        if pushing {
            let _ = self.set_state(run, json!({"inFlight": null})).await;
        }
        // What the ShipRunner moved is now part of the baseline.
        self.rebase_snapshot(run).await;
        {
            let mut state = run.lock();
            state.expected_refs.clear();
            state.checkout_may_move = false;
            state.config_may_change = false;
        }
        for result in &results {
            if result.item.kind == "land" {
                self.landed(run, result).await;
                continue;
            }
            if !matches!(result.item.kind.as_str(), "push" | "pr") || result.item.state == "done" {
                continue;
            }
            // A rejected or unreachable push is reported (the queue item keeps its reason, the agent gets a note) and the next
            // cycle repairs it: merge the remote branch, never force. The run is not paused for it.
            let (branch, remote) = {
                let state = run.lock();
                (state.branch.clone(), state.settings.remote())
            };
            let why = result.item.detail.as_deref().unwrap_or("unknown reason");
            self.tell_agent(
                run,
                format!("The push of {branch} failed: {why}. Autopilot never forces a push: run git fetch, merge {remote}/{branch} into the branch, check again, and the next green cycle pushes it."),
            )
            .await;
        }
        results
    }

    /// What a land did, told where it matters: a default branch that moved (or a merge that would conflict) is a note to the
    /// next cycle, never a stop; the first fallback to a pull request is said once (status line, notification, note).
    async fn landed(self: &Arc<Self>, run: &Arc<Run>, result: &ShipResult) {
        let (remote, dest, branch) = {
            let state = run.lock();
            (
                state.settings.remote(),
                state
                    .land_to
                    .clone()
                    .unwrap_or_else(|| state.base_branch.clone()),
                state.branch.clone(),
            )
        };
        match &result.land {
            Some(ship::LandOutcome::Landed { sha, merge }) => {
                run.lock().landed_count += 1;
                let Some(merge) = merge else { return };
                self.log(&format!(
                    "{}: landed {} on {remote}/{dest}: the merge of {}, checked with {}",
                    run.tab,
                    short(sha),
                    short(&merge.onto),
                    merge.check
                ));
                let said = if merge.advanced {
                    format!(
                        "Landed on {remote}/{dest} as a merge with the commits it had gained ({}), after your check passed on that merge. {branch} was fast-forwarded to it, so your worktree now has them too.",
                        short(sha)
                    )
                } else {
                    format!(
                        "Landed on {remote}/{dest} as a merge with the commits it had gained ({}), after your check passed on that merge. {branch} moved on meanwhile, so run git fetch {remote} && git merge {remote}/{dest} before your next commit.",
                        short(sha)
                    )
                };
                self.tell_agent(run, said).await;
            }
            Some(ship::LandOutcome::Red {
                check,
                exit_code,
                timed_out,
                tail,
                ..
            }) => {
                let why = if *timed_out {
                    "timed out".to_owned()
                } else {
                    format!(
                        "exit {}",
                        exit_code.map_or("unknown".to_owned(), |code| code.to_string())
                    )
                };
                let tail = js_trim(tail);
                let printed = if tail.is_empty() {
                    String::new()
                } else {
                    format!("\nWhat the check printed (its first error, then its end):\n{tail}")
                };
                self.tell_agent(
                    run,
                    format!("Not landed: {remote}/{dest} moved on; it merges with this cycle's commit without conflicts, but your check ({check}) fails on that merge ({why}). Run git fetch {remote} && git merge {remote}/{dest}, fix what the merge broke, run the check, and commit; the next green cycle lands it.{printed}"),
                )
                .await;
            }
            Some(ship::LandOutcome::Behind { conflicts, .. }) => {
                let files = conflicts.clone().unwrap_or_default();
                let merge = format!("git fetch {remote} && git merge {remote}/{dest}");
                let said = if files.is_empty() {
                    format!(
                        "Not landed: {remote}/{dest} has commits this run lacks. Run {merge}, run the check, and commit; the next green cycle lands it. Never force anything."
                    )
                } else {
                    format!(
                        "Not landed: {remote}/{dest} moved on, and merging it conflicts in {}. Run {merge}, resolve the conflicts keeping both sides' intent, run the check, and commit; the next green cycle lands it.",
                        files.join(", ")
                    )
                };
                self.tell_agent(run, said).await;
            }
            Some(ship::LandOutcome::Pr { url, reason, .. }) => {
                if run.lock().landing.is_some() {
                    return;
                }
                let mut landing = json!({"via": "pr", "reason": reason});
                if let Some(url) = url {
                    landing["url"] = json!(url);
                }
                run.lock().landing = Some(landing);
                self.touch(run);
                let shown = url.clone().unwrap_or_else(|| "a pull request".to_owned());
                self.log(&format!(
                    "{}: {remote}/{dest} refused the land ({reason}); lands go to {shown}",
                    run.tab
                ));
                let title = self.text("autopilot.land.prTitle", json!({})).await;
                let body = self
                    .text("autopilot.land.prBody", json!({"branch": dest, "url": url.clone().unwrap_or_else(|| branch.clone())}))
                    .await;
                self.notify(run, "error", title, body);
                self.tell_agent(
                    run,
                    format!("{remote}/{dest} refused a direct push ({reason}). Green cycles now update {branch} and its pull request {} instead; keep working as before.", url.clone().unwrap_or_default()),
                )
                .await;
                self.refresh(run).await;
            }
            None => {
                let why = result.item.detail.as_deref().unwrap_or("unknown reason");
                self.tell_agent(
                    run,
                    format!("Landing on {remote}/{dest} failed: {why}. Nothing was forced; the next green cycle tries again."),
                )
                .await;
            }
        }
    }

    // ---- the nudge, the quota wait ------------------------------------------------------------------------------

    /// The run is still this tab's, running, and nothing else holds its next turn: no turn going, no stock auto-retry, no
    /// retry TurnResume armed, no wait for the connection. `nudge` asks it right before it prompts.
    async fn quiet_and_running(&self, run: &Arc<Run>) -> bool {
        if !self.is_current(run) || run.lock().stopping {
            return false;
        }
        let Some(facts) = self.facts(&run.tab).await else {
            return false;
        };
        if facts.busy || facts.awaiting_connection || facts.retrying || facts.scheduled_retry {
            return false;
        }
        let status = self.fetch_status(run).await.ok();
        status.is_some_and(|status| text(&status, "state") == Some("running"))
    }

    /// The run went quiet (plan mode, every todo blocked, no turn started, a failed turn nobody retries): leave plan mode and
    /// ask for the next cycle. Never a pause; at most one ask per nudge window. An ask inside that window is asked again once
    /// it passes, never dropped: a failed turn reports its failure once, so nothing else would wake the run. The run is
    /// checked right before the ask, since it runs from the cycle-end queue and the user may pause or stop meanwhile.
    fn nudge(self: &Arc<Self>, run: &Arc<Run>, reason: &str) -> ship::Fut<R<()>> {
        let (this, run, reason) = (self.clone(), run.clone(), reason.to_owned());
        Box::pin(async move { this.nudge_now(&run, &reason).await })
    }

    async fn nudge_now(self: &Arc<Self>, run: &Arc<Run>, reason: &str) -> R<()> {
        let now = self.now();
        let (stopping, next) = {
            let state = run.lock();
            (state.stopping, state.next_nudge_at)
        };
        if stopping {
            return Ok(());
        }
        if now < next {
            {
                let mut state = run.lock();
                if state.nudge_later {
                    return Ok(());
                }
                state.nudge_later = true;
            }
            let (this, again, reason) = (self.clone(), run.clone(), reason.to_owned());
            after((next - now) as u64, move || {
                again.lock().nudge_later = false;
                let (co, target, why) = (this.clone(), again.clone(), reason.clone());
                this.enqueue(&again, "nudge", None, async move {
                    co.nudge(&target, &why).await
                });
            });
            return Ok(());
        }
        if !self.quiet_and_running(run).await {
            return Ok(());
        }
        let window = if reason == "error" {
            self.tuning.error_nudge_ms
        } else {
            self.tuning.nudge_ms
        };
        run.lock().next_nudge_at = now + window as i64;
        if reason == "plan" {
            let _ = self
                .stock(&run.tab, json!({"type": "set_plan_mode", "enabled": false}))
                .await;
            if !self.quiet_and_running(run).await {
                return Ok(());
            }
        }
        let asked = self
            .stock_response(
                &run.tab,
                json!({"type": "prompt", "message": nudge_message(reason), "streamingBehavior": "followUp"}),
            )
            .await;
        if let Err(error) = asked {
            self.log(&format!("nudge: {}", error.message));
        }
        Ok(())
    }

    /// A turn ended on the account's usage limit and stock's auto-retry let it go: the run waits until the provider's first
    /// account resets (its usage reports; a short fallback when none names a reset), journaled as `waiting_quota` with that
    /// time so every window, a paired device and a relaunch see it. Main owns the wake: it fires with no window open. Never a
    /// pause.
    async fn wait_for_quota(self: &Arc<Self>, run: &Arc<Run>) -> R<()> {
        if !self.is_current(run) || run.lock().stopping {
            return Ok(());
        }
        let Some(facts) = self.facts(&run.tab).await else {
            return Ok(());
        };
        if facts.busy || facts.retrying {
            return Ok(());
        }
        let status = self.fetch_status(run).await.ok();
        if status.is_none_or(|status| text(&status, "state") != Some("running")) {
            return Ok(());
        }
        let state = self
            .stock(&run.tab, json!({"type": "get_state"}))
            .await
            .ok();
        let usage = self
            .stock(&run.tab, json!({"type": "get_usage"}))
            .await
            .ok();
        let now = self.now();
        let reports = usage
            .as_ref()
            .and_then(|usage| usage.get("reports"))
            .filter(|reports| reports.is_array())
            .cloned()
            .unwrap_or_else(|| json!([]));
        let provider = state
            .as_ref()
            .and_then(|state| state.get("model"))
            .and_then(|model| text(model, "provider"))
            .map(str::to_owned);
        let reset_at: i64 = self
            .port
            .ask(
                "quotaWait",
                &json!({"reports": reports, "provider": provider, "now": now}),
            )
            .await?;
        run.lock().quota_retries = 0;
        self.set_state(
            run,
            json!({"state": "waiting_quota", "quotaResetAt": reset_at}),
        )
        .await?;
        self.arm_quota_wake(run, reset_at, false);
        Ok(())
    }

    pub fn arm_quota_wake(self: &Arc<Self>, run: &Arc<Run>, at: i64, restarted: bool) {
        let (this, again) = (self.clone(), run.clone());
        let wait = (at - self.now()).max(0) as u64;
        let timer = after(wait, move || {
            again.lock().quota_wake = None;
            let (co, target) = (this.clone(), again.clone());
            this.enqueue(&again, "quota wake", None, async move {
                co.quota_wake(&target, restarted).await
            });
        });
        let previous = run.lock().quota_wake.replace(timer);
        if let Some(cancel) = previous {
            cancel.cancel();
        }
    }

    /// The reset came: a run still waiting (not paused, stopped or resumed meanwhile) goes on. In this process stock's `retry`
    /// takes the failed turn up again; after a relaunch stock paused the goal at startup, so it resumes as a restart does.
    async fn quota_wake(self: &Arc<Self>, run: &Arc<Run>, restarted: bool) -> R<()> {
        if !self.is_current(run) || run.lock().stopping {
            return Ok(());
        }
        let status = self.fetch_status(run).await.ok();
        if status.is_none_or(|status| text(&status, "state") != Some("waiting_quota")) {
            return Ok(());
        }
        self.set_state(run, json!({"state": "running"})).await?;
        if restarted {
            self.continue_or_pause(run).await;
            return Ok(());
        }
        let retried = self
            .stock_response(&run.tab, json!({"type": "retry"}))
            .await
            .ok();
        if retried
            .as_ref()
            .is_some_and(|response| flag(response, "success"))
        {
            run.lock().quota_retries = 0;
            return Ok(());
        }
        // A turn is already under way (a message of the user's, a nudge): the run is going on.
        if let Some(facts) = self.facts(&run.tab).await
            && (facts.busy || facts.retrying)
        {
            return Ok(());
        }
        // The retry did not take: wait again, visibly (`waiting_quota` with the time of the next try), at the next reset the
        // provider reports or after a backoff of at most the maximum, whichever is sooner. It repeats until the run goes on.
        let now = self.now();
        let retries = {
            let mut state = run.lock();
            let retries = state.quota_retries;
            state.quota_retries += 1;
            retries
        };
        let backoff = self.tuning.quota_retry_max_ms.min(
            self.tuning
                .quota_retry_min_ms
                .saturating_mul(1u64 << retries.min(20)),
        );
        let next = now + backoff as i64;
        self.log(&format!(
            "{}: the retry after the quota wait failed; trying again at {next}",
            run.tab
        ));
        self.set_state(run, json!({"state": "waiting_quota", "quotaResetAt": next}))
            .await?;
        self.arm_quota_wake(run, next, false);
        Ok(())
    }

    // ---- stop, abort, resume ----------------------------------------------------------------------------------

    /// ■ (`STOP_COMMANDS` in `ipc.ts`): the running children stop with the parent; the run shows paused.
    pub async fn aborted(self: &Arc<Self>, tab: &str) {
        let Some(run) = self.runs_get(tab) else {
            return;
        };
        let children: Vec<String> = run
            .lock()
            .children
            .iter()
            .map(|child| child.tab.clone())
            .collect();
        let stops = children.into_iter().map(|child| async move {
            if !self.facts(&child).await.is_some_and(|facts| facts.busy) {
                return;
            }
            self.port.tell("noteStopped", &json!({"tab": child}));
            self.port.tell(
                "turnStop",
                &json!({"command": "abort", "tab": child, "by": "autopilot", "surface": "run-stopped", "caller": tab}),
            );
            let _ = self.stock(&child, json!({"type": "abort"})).await;
        });
        futures_join(stops).await;
        if run.lock().stopping {
            return;
        }
        if let Err(error) = self
            .set_state(&run, json!({"state": "paused", "reason": "user_abort"}))
            .await
        {
            self.log(&format!("abort state: {}", error.message));
        }
    }

    /// "Stop" (the user ends the run) or an end the bridge asked for: finish the turn, then wind down.
    pub async fn begin_stop(self: &Arc<Self>, run: &Arc<Run>, reason: &str) {
        {
            let mut state = run.lock();
            if state.stopping {
                return;
            }
            state.stopping = true;
        }
        self.touch(run);
        let _ = self
            .stock(&run.tab, json!({"type": "set_goal", "action": "pause"}))
            .await;
        let _ = self
            .set_state(run, json!({"state": "stopping", "reason": reason}))
            .await;
        let children: Vec<String> = run
            .lock()
            .children
            .iter()
            .map(|child| child.tab.clone())
            .collect();
        let clears = children.into_iter().map(|child| async move {
            let _ = self
                .port
                .ask::<Value, _>("clearQueue", &json!({"tab": child}))
                .await;
        });
        futures_join(clears).await;
        // No turn in flight: no `agent_end` will bring `autopilot_settled`.
        if !self.facts(&run.tab).await.is_some_and(|facts| facts.busy) {
            let (this, again, why) = (self.clone(), run.clone(), reason.to_owned());
            self.enqueue(run, "settle", None, async move {
                this.settled(&again, &why).await
            });
        }
    }

    /// "Ship, then stop": the next cycle that begins is told to land its work and release when a release is due, and the run
    /// ends after that cycle (`cycle_end`). A paused run resumes for it; a second press cancels it.
    pub async fn stop_after_ship(
        self: &Arc<Self>,
        run: &Arc<Run>,
        enabled: bool,
        chosen_at: Option<i64>,
    ) -> R<()> {
        if run.lock().stopping {
            return Ok(());
        }
        let note = &self.contracts.bridge.note;
        if !enabled {
            {
                let mut state = run.lock();
                if state.end_after_ship.is_none() {
                    return Ok(());
                }
                state.end_after_ship = None;
                state.ship_stop_waits_release = false;
                state.release_owed = false;
            }
            self.touch(run);
            let _ = self
                .bridge(
                    &run.tab,
                    note,
                    json!({"text": STOP_AFTER_SHIP_CANCELLED}),
                    None,
                )
                .await;
            return Ok(());
        }
        {
            let mut state = run.lock();
            if state.end_after_ship.is_some() {
                return Ok(());
            }
            state.end_after_ship = Some(chosen_at.unwrap_or_else(|| self.now()));
        }
        self.touch(run);
        self.bridge(&run.tab, note, json!({"text": STOP_AFTER_SHIP_NOTE}), None)
            .await?;
        let status = self.fetch_status(run).await.ok();
        if status.is_some_and(|status| text(&status, "state") == Some("paused")) {
            self.resume(run).await?;
        }
        Ok(())
    }

    pub async fn resume(self: &Arc<Self>, run: &Arc<Run>) -> R<()> {
        let wake = {
            let mut state = run.lock();
            state.stopping = false;
            state.quota_wake.take()
        };
        if let Some(cancel) = wake {
            cancel.cancel();
        }
        self.touch(run);
        let status = self.fetch_status(run).await?;
        self.arm(run, &status, true).await?;
        let response = self
            .stock_response(&run.tab, json!({"type": "set_goal", "action": "resume"}))
            .await?;
        if !flag(&response, "success") {
            let message = text(&response, "error").unwrap_or("The goal could not be resumed.");
            return Err(oops("autopilot_failed", message));
        }
        Ok(())
    }

    async fn arm(&self, run: &Arc<Run>, status: &Value, resume: bool) -> R<()> {
        let (root, run_id, branch, base_branch, target, settings, checkout) = {
            let state = run.lock();
            (
                state.root.clone(),
                state.run.clone(),
                state.branch.clone(),
                state.base_branch.clone(),
                state.target.clone(),
                state.settings.0.clone(),
                state.checkout_root.clone(),
            )
        };
        let settings = status
            .get("settings")
            .filter(|settings| settings.is_object())
            .cloned()
            .unwrap_or(settings);
        let (procedure, blocked) = self.release_for(&root).await;
        let mut arm = json!({
            "role": "parent", "root": root, "run": run_id, "branch": branch, "baseBranch": base_branch,
            "settings": settings, "resume": resume,
        });
        if let Some(target) = target {
            arm["target"] = json!(target);
        }
        if let Some(procedure) = procedure {
            arm["releaseProcedure"] = procedure;
        }
        if let Some(blocked) = blocked {
            arm["releaseBlocked"] = json!(blocked);
        }
        let armed = self
            .bridge(&run.tab, &self.contracts.bridge.arm, arm, None)
            .await?;
        run.lock().status = Some(armed);
        let snapshot = self.snapshot(&root, &checkout).await;
        let mut state = run.lock();
        if snapshot.is_some() {
            state.snapshot = snapshot;
        }
        Ok(())
    }

    /// TurnResume's goal resume after a relaunch (`ResumeDeps.resumeGoal`): an autopilot run is armed again first
    /// (overrides, tools and guard before the goal), any other tab gets stock's own resume.
    pub async fn resume_goal(self: &Arc<Self>, tab: &str) -> R<()> {
        // TurnResume's restore/retry chain is shorter than `on_ready`'s adoption: adopt here, not through `awaiting_resume`.
        let run = match self.runs_get(tab) {
            Some(run) => Some(run),
            None => self.adopt(tab).await,
        };
        let status = match &run {
            Some(run) => self.fetch_status(run).await.ok(),
            None => None,
        };
        let state = status
            .as_ref()
            .and_then(|status| text(status, "state"))
            .map(str::to_owned);
        if let (Some(run), Some("running")) = (&run, state.as_deref()) {
            // `on_ready` already continued this readiness (TurnResume's marker was not in place yet when it judged).
            if locked(&self.continued_on_ready).remove(tab) {
                return Ok(());
            }
            // `on_ready` has not judged this readiness yet when it is not waiting on us: it must not resume it again.
            if !locked(&self.awaiting_resume).remove(tab) {
                locked(&self.resumed_on_launch).insert(tab.to_owned());
            }
            if let Err(error) = self.continue_after_restart(run).await {
                // Shown paused with Resume; TurnResume drops the marker, so the next launch does not resume it unarmed.
                self.closed_quietly(run).await;
                return Err(error);
            }
            return Ok(());
        }
        // A resume without an arm leaves the run on the startup tool set: say why, so a missing arm explains itself.
        self.log(&format!(
            "resumeGoal {tab}: plain stock resume (run {}, state {})",
            if run.is_some() { "adopted" } else { "none" },
            state.as_deref().unwrap_or("unread"),
        ));
        let response = self
            .stock_response(tab, json!({"type": "set_goal", "action": "resume"}))
            .await?;
        if !flag(&response, "success") {
            return Err(Oops::from(
                text(&response, "error").unwrap_or("the tab is gone"),
            ));
        }
        Ok(())
    }

    /// TurnResume finished a tab's launch continuation. A run it did not resume goes on all the same: the journal says
    /// `running`, whatever the restore read from stock's journal of the cut. Only the user's Stop on the "Continuing" toast
    /// leaves it paused.
    pub fn resume_settled(self: &Arc<Self>, tab: &str, outcome: &str) {
        if outcome == "resumed" || !locked(&self.awaiting_resume).remove(tab) {
            return;
        }
        let Some(run) = self.runs_get(tab) else {
            return;
        };
        let (this, cancelled) = (self.clone(), outcome == "cancelled");
        self.track(async move {
            if cancelled {
                this.closed_quietly(&run).await;
            } else {
                this.continue_or_pause(&run).await;
            }
        });
    }

    pub async fn on_ready(self: &Arc<Self>, tab: &str) -> R<()> {
        if locked(&self.child_runs).contains_key(tab) {
            return Ok(());
        }
        let Some(run) = self.adopt(tab).await else {
            return Ok(());
        };
        if run.lock().starting || locked(&self.resumed_on_launch).remove(tab) {
            return Ok(());
        }
        let status = self.fetch_status(&run).await?;
        if text(&status, "state") == Some("waiting_quota") {
            // A wait the last process journaled: stock paused the goal at startup, so the wake resumes it like a restart.
            let at = number(&status, "quotaResetAt").unwrap_or_else(|| self.now());
            self.arm_quota_wake(&run, at, true);
            return Ok(());
        }
        if text(&status, "state") != Some("running") || locked(&self.resumed_on_launch).remove(tab)
        {
            return Ok(());
        }
        // The process came up with the run `running` in its journal (a relaunch, or its omp restarted): stock paused the goal
        // at startup. The run goes on after any restart; with a launch marker, after TurnResume's restore.
        let continuation: String = self.port.ask("relaunch", &json!({"tab": tab})).await?;
        match continuation.as_str() {
            "after_restore" => {
                locked(&self.awaiting_resume).insert(tab.to_owned());
            }
            "now" => {
                locked(&self.continued_on_ready).insert(tab.to_owned());
                self.continue_or_pause(&run).await;
            }
            _ => self.app_closed(&run).await?,
        }
        Ok(())
    }

    /// The run goes on after a restart; if stock cannot resume its goal, it shows paused with Resume.
    async fn continue_or_pause(self: &Arc<Self>, run: &Arc<Run>) {
        if let Err(error) = self.continue_after_restart(run).await {
            self.log(&format!("resume after restart: {}", error.message));
            self.closed_quietly(run).await;
        }
    }

    /// Arm and resume a run whose omp came up again. Stock reattached the goal paused at startup and remembered the tool set
    /// of that moment (ask, eval, debug and no `autopilot`); its `goal resume` would put that set back over the armed one. Its
    /// `goal pause` drops what it remembered (stock restores it and forgets it), so the arm comes after the pause and the
    /// resume keeps the armed set, as it does for a run the user resumes.
    async fn continue_after_restart(self: &Arc<Self>, run: &Arc<Run>) -> R<()> {
        let paused = self
            .stock_response(&run.tab, json!({"type": "set_goal", "action": "pause"}))
            .await?;
        if !flag(&paused, "success") {
            let message = text(&paused, "error").unwrap_or("The goal could not be paused.");
            return Err(oops("autopilot_failed", message));
        }
        self.resume(run).await
    }

    async fn closed_quietly(&self, run: &Arc<Run>) {
        if let Err(error) = self.app_closed(run).await {
            self.log(&format!("app_closed: {}", error.message));
        }
    }

    async fn app_closed(&self, run: &Arc<Run>) -> R<()> {
        let _ = self
            .stock(&run.tab, json!({"type": "set_goal", "action": "pause"}))
            .await;
        self.set_state(run, json!({"state": "paused", "reason": "app_closed"}))
            .await
    }

    // ---- configure and ship actions ---------------------------------------------------------------------------

    pub async fn configure(&self, run: &Arc<Run>, changes: Value) -> R<()> {
        let turns_on = changes
            .get("ship")
            .and_then(|ship| ship.get("autoRelease"))
            .and_then(|release| release.get("on"))
            == Some(&Value::Bool(true));
        if turns_on {
            let root = run.lock().root.clone();
            if self.release_for(&root).await.0.is_none() {
                return Err(oops(
                    "autopilot_no_release",
                    self.text("autopilot.err.noRelease", json!({})).await,
                ));
            }
        }
        let status = self
            .bridge(&run.tab, &self.contracts.bridge.configure, changes, None)
            .await?;
        if let Some(settings) = status
            .get("settings")
            .filter(|settings| settings.is_object())
        {
            let changed = {
                let mut state = run.lock();
                let changed = state.settings.0.get("ship") != settings.get("ship");
                state.settings = Settings(settings.clone());
                changed
            };
            if changed {
                self.touch(run);
            }
        }
        Ok(())
    }

    pub async fn ship_action(self: &Arc<Self>, run: &Arc<Run>, action: &Value) -> R<()> {
        let kind = text(action, "kind").unwrap_or_default();
        if kind == "auto_release" {
            let current = run
                .lock()
                .settings
                .ship()
                .get("autoRelease")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let mut release = current;
            release["on"] = json!(flag(action, "enabled"));
            return self
                .configure(run, json!({"ship": {"autoRelease": release}}))
                .await;
        }
        let root = run.lock().root.clone();
        if kind == "release" {
            let Some(_) = self.release_for(&root).await.0 else {
                return Err(oops(
                    "autopilot_no_release",
                    self.text("autopilot.err.noRelease", json!({})).await,
                ));
            };
            let item = run
                .ship
                .track(Some("requested".into()), random_id(), self.now());
            run.lock().release_item = Some(item.id);
            self.stock_response(
                &run.tab,
                json!({"type": "prompt", "message": RELEASE_NOW_MESSAGE, "streamingBehavior": "followUp"}),
            )
            .await?;
            return Ok(());
        }
        // Merge lands the run's own branch on the base; a PR is opened from the branch Push moves (the target, when there is
        // one).
        let (branch, base, target) = {
            let state = run.lock();
            (
                state.branch.clone(),
                state.base_branch.clone(),
                state.target.clone(),
            )
        };
        let nothing_to_ship = match kind {
            "merge" => branch == base,
            "pr" => target.as_deref().unwrap_or(&branch) == base,
            _ => false,
        };
        if nothing_to_ship {
            return Err(oops(
                "autopilot_on_base",
                self.text("autopilot.err.onBase", json!({})).await,
            ));
        }
        if kind == "revert" {
            let wanted = number(action, "cycle");
            // The cycle's commit is read from the bridge's journal now (the copy kept here is as old as the last turn's end); a
            // bridge that cannot answer leaves the kept one.
            let fresh = self.fetch_status(run).await.ok();
            let cycle = fresh
                .or_else(|| run.lock().status.clone())
                .as_ref()
                .and_then(|status| status.get("cycles"))
                .and_then(Value::as_array)
                .and_then(|cycles| {
                    cycles
                        .iter()
                        .find(|entry| number(entry, "n") == wanted)
                        .cloned()
                });
            let Some(cycle) = cycle
                .filter(|cycle| text(cycle, "commit").is_some_and(|commit| !commit.is_empty()))
            else {
                return Err(oops(
                    "autopilot_no_commit",
                    self.text("autopilot.err.noCommit", json!({})).await,
                ));
            };
            let request = Request {
                kind: "revert".into(),
                cycle: number(&cycle, "n"),
                sha: text(&cycle, "commit").map(str::to_owned),
                mode: None,
                check: None,
            };
            run.ship.enqueue(&request, random_id(), self.now());
        } else {
            let request = Request {
                kind: kind.to_owned(),
                cycle: None,
                sha: None,
                mode: text(action, "mode").map(str::to_owned),
                check: None,
            };
            run.ship.enqueue(&request, random_id(), self.now());
        }
        // Between turns it runs now; inside one, at that turn's end (`cycle_end`). The pool's busy flag can lag a turn's
        // start, so a cycle the journal shows in flight (`begin` called, no record yet) holds the queue too.
        let status = self.fetch_status(run).await.ok();
        let in_flight = status.as_ref().is_some_and(|status| {
            status.get("now").is_some_and(|now| !now.is_null())
                && matches!(text(status, "state"), Some("running" | "stopping"))
        });
        let busy = self.facts(&run.tab).await.is_some_and(|facts| facts.busy);
        if !busy && !in_flight {
            let (this, again) = (self.clone(), run.clone());
            let max = Some(Duration::from_millis(self.tuning.cycle_end_max_ms));
            self.enqueue(run, "ship queue", max, async move {
                this.drain(&again, None).await;
                Ok(())
            });
        }
        Ok(())
    }

    // ---- stops ------------------------------------------------------------------------------------------------

    async fn stop_requested(self: &Arc<Self>, run: &Arc<Run>, request: &Value) -> R<()> {
        if run.lock().stopping {
            return Ok(());
        }
        let reason = text(request, "reason").unwrap_or_default();
        if flag(request, "end") {
            self.begin_stop(run, reason).await;
            return Ok(());
        }
        self.pause(run, reason, text(request, "detail")).await
    }

    async fn pause(self: &Arc<Self>, run: &Arc<Run>, reason: &str, detail: Option<&str>) -> R<()> {
        if run.lock().stopping {
            return Ok(());
        }
        let _ = self
            .stock(&run.tab, json!({"type": "set_goal", "action": "pause"}))
            .await;
        let mut change = json!({"state": "paused", "reason": reason});
        if let Some(detail) = detail.filter(|detail| !detail.is_empty()) {
            change["detail"] = json!(detail);
        }
        self.set_state(run, change).await?;
        self.report_stop(run, reason, detail).await;
        Ok(())
    }

    /// The last turn of a stopping run settled.
    async fn settled(self: &Arc<Self>, run: &Arc<Run>, reason: &str) -> R<()> {
        let cycle = run
            .lock()
            .status
            .as_ref()
            .and_then(|status| number(status, "cycle"))
            .unwrap_or(0);
        self.close_children(run, cycle).await;
        self.drain(run, None).await;
        let polling = run.lock().stop_polling.take();
        if let Some(cancel) = polling {
            cancel.cancel();
        }
        let ending = matches!(reason, "user" | "agent_done" | "tab_closed");
        if !ending {
            self.set_state(run, json!({"state": "paused", "reason": reason}))
                .await?;
            run.lock().stopping = false;
            self.touch(run);
            self.report_stop(run, reason, None).await;
            return Ok(());
        }
        let (line, details) = self.summary(run, reason, None).await;
        self.set_state(run, json!({"state": "ended", "reason": reason}))
            .await?;
        let _ = self
            .stock(&run.tab, json!({"type": "set_goal", "action": "drop"}))
            .await;
        if let Err(error) = self
            .bridge(&run.tab, &self.contracts.bridge.disarm, json!({}), None)
            .await
        {
            self.log(&format!("disarm: {}", error.message));
        }
        self.port
            .tell("runLog", &json!({"message": "ended", "details": details}));
        let title = self.text("autopilot.ended.title", json!({})).await;
        self.notify(run, "completion", title, line);
        let root = run.lock().root.clone();
        locked(&self.runs).remove(&run.tab);
        self.port
            .tell("mirror", &json!({"tab": run.tab, "gone": true}));
        self.port.tell("runEnded", &json!({"root": root}));
        Ok(())
    }

    // ---- children ---------------------------------------------------------------------------------------------

    /// `AgentControlHostDeps.beforeFirstPrompt`: arm a session the run opened before it gets its prompt.
    pub async fn before_first_prompt(self: &Arc<Self>, child: &Value) -> R<()> {
        let tab = text(child, "tabId").unwrap_or_default().to_owned();
        let caller = text(child, "callerTabId").unwrap_or_default().to_owned();
        // The tool path (`ompdesk_session_open`) passes no tag, so every session an autopilot run's tab opens is its child; a
        // tagged one whose caller is no run (a stale tag) is refused below.
        if text(child, "tag") != Some(self.contracts.child_tag.as_str())
            && self.runs_get(&caller).is_none()
        {
            return Ok(());
        }
        let Some(run) = self.runs_get(&caller) else {
            return Err(Oops::from(
                "Autopilot is not running in the session that opened this one.",
            ));
        };
        if run.lock().stopping {
            return Err(Oops::from("Autopilot is ending: start nothing new."));
        }
        let worktree = child
            .get("worktree")
            .filter(|worktree| worktree.is_object());
        let root = match worktree.and_then(|worktree| text(worktree, "path")) {
            Some(path) => path.to_owned(),
            None => match self.sidecar(&tab).await {
                Some(sidecar) => sidecar.cwd,
                None => run.lock().root.clone(),
            },
        };
        let branch = worktree
            .and_then(|worktree| text(worktree, "branch"))
            .unwrap_or_default()
            .to_owned();
        let (run_id, run_branch, remote, settings) = {
            let state = run.lock();
            (
                state.run.clone(),
                state.branch.clone(),
                state.settings.remote(),
                state.settings.0.clone(),
            )
        };
        let mut ship = self.contracts.default_ship_policy.clone();
        ship["remote"] = json!(remote);
        let mut child_settings = settings;
        child_settings["ship"] = ship;
        child_settings["limits"] = self.contracts.no_limits.clone();
        let arm = json!({
            "role": "child", "root": root, "run": run_id, "branch": branch, "baseBranch": run_branch,
            "settings": child_settings, "parentTab": run.tab,
        });
        self.bridge(&tab, &self.contracts.bridge.arm, arm, None)
            .await?;
        let child_run = ChildRun {
            parent: run.tab.clone(),
            root: root.clone(),
        };
        locked(&self.child_runs).insert(tab.clone(), child_run.clone());
        self.touch_child(&tab, Some(&child_run));
        {
            let mut state = run.lock();
            state.children.push(Child {
                tab: tab.clone(),
                branch: (!branch.is_empty()).then(|| branch.clone()),
                worktree: worktree
                    .and_then(|worktree| text(worktree, "path"))
                    .map(str::to_owned),
                area: None,
            });
            if !branch.is_empty() {
                state.child_branches.insert(branch);
            }
        }
        self.touch(&run);
        let (this, again) = (self.clone(), run.clone());
        self.track(async move { this.refresh(&again).await });
        Ok(())
    }

    /// Usage of every child of the cycle, its tab closed and its clean, merged worktree removed.
    async fn close_children(self: &Arc<Self>, run: &Arc<Run>, cycle: i64) {
        let children: Vec<Child> = std::mem::take(&mut run.lock().children);
        self.touch(run);
        let (mut tokens, mut usd) = (0f64, 0f64);
        for child in &children {
            let stats = self
                .stock(&child.tab, json!({"type": "get_session_stats"}))
                .await
                .ok();
            tokens += stats
                .as_ref()
                .and_then(|stats| stats.get("tokens"))
                .and_then(|tokens| tokens.get("total"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            usd += stats
                .as_ref()
                .and_then(|stats| stats.get("cost"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            if self.facts(&child.tab).await.is_some_and(|facts| facts.busy) {
                self.port.tell("noteStopped", &json!({"tab": child.tab}));
                self.port.tell(
                    "turnStop",
                    &json!({"command": "abort", "tab": child.tab, "by": "autopilot", "surface": "run-ended"}),
                );
                let _ = self.stock(&child.tab, json!({"type": "abort"})).await;
            }
            if locked(&self.child_runs).remove(&child.tab).is_some() {
                self.touch_child(&child.tab, None);
            }
            let _ = self
                .port
                .ask::<Value, _>("release", &json!({"tab": child.tab}))
                .await;
            self.remove_child_worktree(run, child).await;
        }
        if !children.is_empty() && (tokens > 0.0 || usd > 0.0) && cycle > 0 {
            let amend = json!({"n": cycle, "tokens": tokens, "usd": usd});
            if let Err(error) = self
                .bridge(&run.tab, &self.contracts.bridge.cycle_amend, amend, None)
                .await
            {
                self.log(&format!("cycle amend: {}", error.message));
            }
        }
        if !children.is_empty() {
            let (this, again) = (self.clone(), run.clone());
            self.track(async move { this.refresh(&again).await });
        }
    }

    /// `git worktree remove` (no force) when the child's branch is merged into the run's and its tree is clean.
    async fn remove_child_worktree(&self, run: &Arc<Run>, child: &Child) {
        let (Some(worktree), Some(branch)) = (&child.worktree, &child.branch) else {
            return;
        };
        let Ok(git) = self.git().await else { return };
        let (root, own) = {
            let state = run.lock();
            (state.root.clone(), state.branch.clone())
        };
        let merged = git
            .run(
                &root,
                &["merge-base", "--is-ancestor", branch, &own],
                slow(),
            )
            .await
            .ok();
        if merged.is_none_or(|merged| merged.code != 0) {
            return;
        }
        let dirty = git
            .run(worktree, &["status", "--porcelain"], slow())
            .await
            .ok();
        if dirty.is_none_or(|dirty| dirty.code != 0 || !js_trim(&dirty.text()).is_empty()) {
            return;
        }
        let _ = git
            .run(&root, &["worktree", "remove", worktree], slow())
            .await;
    }

    // ---- the release run --------------------------------------------------------------------------------------

    async fn release_reported(self: &Arc<Self>, run: &Arc<Run>, ship: &Value) {
        let version = text(ship, "version").unwrap_or_default().to_owned();
        let existing = run.lock().release_item.clone();
        let item = match existing {
            Some(item) => item,
            None => {
                run.ship
                    .track(Some(version.clone()), random_id(), self.now())
                    .id
            }
        };
        run.lock().release_item = Some(item.clone());
        let configure = &self.contracts.bridge.configure;
        let Some(url) = text(ship, "runUrl").filter(|url| !url.is_empty()) else {
            run.ship.finish(&item, "done", Some(version.clone()), None);
            run.lock().release_item = None;
            let _ = self
                .bridge(
                    &run.tab,
                    configure,
                    json!({"release": {"version": version, "state": "success"}}),
                    None,
                )
                .await;
            return;
        };
        let _ = self
            .bridge(
                &run.tab,
                configure,
                json!({"release": {"version": version, "runUrl": url, "state": "pending"}}),
                None,
            )
            .await;
        self.poll_release(run, version, url.to_owned());
    }

    pub fn poll_release(self: &Arc<Self>, run: &Arc<Run>, version: String, url: String) {
        let previous = run.lock().stop_polling.take();
        if let Some(cancel) = previous {
            cancel.cancel();
        }
        let busy = Arc::new(AtomicBool::new(false));
        let (this, again) = (self.clone(), run.clone());
        let timer = every(self.tuning.release_poll_ms, move || {
            if busy.swap(true, Ordering::SeqCst) {
                return;
            }
            let (co, target, version, url, busy) = (
                this.clone(),
                again.clone(),
                version.clone(),
                url.clone(),
                busy.clone(),
            );
            this.track(async move {
                if let Err(error) = co.check_release(&target, &version, &url).await {
                    co.log(&format!("release poll: {}", error.message));
                }
                busy.store(false, Ordering::SeqCst);
            });
        });
        run.lock().stop_polling = Some(timer);
    }

    async fn check_release(self: &Arc<Self>, run: &Arc<Run>, version: &str, url: &str) -> R<()> {
        let root = run.lock().root.clone();
        let info: Option<Value> = self
            .port
            .ask("ghRun", &json!({"cwd": root, "url": url}))
            .await?;
        let Some(info) = info.filter(|info| text(info, "status") == Some("completed")) else {
            return Ok(());
        };
        let polling = run.lock().stop_polling.take();
        if let Some(cancel) = polling {
            cancel.cancel();
        }
        let conclusion = text(&info, "conclusion").map(str::to_owned);
        let ok = conclusion.as_deref() == Some("success");
        let item = run.lock().release_item.take();
        if let Some(item) = item {
            run.ship.finish(
                &item,
                if ok { "done" } else { "failed" },
                Some(version.to_owned()),
                Some(url.to_owned()),
            );
        }
        let state = if ok { "success" } else { "failure" };
        let _ = self
            .bridge(
                &run.tab,
                &self.contracts.bridge.configure,
                json!({"release": {"version": version, "runUrl": url, "state": state}}),
                None,
            )
            .await;
        let title = self.text("autopilot.release.title", json!({})).await;
        let body = self
            .text(
                if ok {
                    "autopilot.release.ok"
                } else {
                    "autopilot.release.failed"
                },
                json!({"version": version}),
            )
            .await;
        self.notify(run, if ok { "completion" } else { "error" }, title, body);
        // "Ship, then stop" ends the run on a release that succeeded; a failed one is owed, and the next cycle repairs it.
        let waiting = run.lock().end_after_ship.is_some();
        if waiting {
            let waited = {
                let mut state = run.lock();
                let waited = state.ship_stop_waits_release;
                state.ship_stop_waits_release = false;
                if !ok {
                    state.release_owed = true;
                } else {
                    state.release_owed = false;
                    if waited {
                        state.end_after_ship = None;
                    }
                }
                waited && ok
            };
            self.touch(run);
            if waited {
                self.begin_stop(run, "user").await;
            }
        }
        // A failed release run is reported (notice above, the run's status) and handed to the next cycle: never a pause.
        if !ok {
            let said = conclusion.unwrap_or_else(|| "failed".to_owned());
            self.tell_agent(
                run,
                format!("The release run of {version} failed ({said}): {url}. Read the failure, fix it and release again."),
            )
            .await;
        }
        Ok(())
    }

    // ---- notifications ----------------------------------------------------------------------------------------

    /// Stops, ends and release outcomes: what a person away from the screen must know. Where it goes (this computer's banner
    /// under its own notifications switch, the paired device that started or shows the run, phones) is main's.
    pub fn notify(&self, run: &Run, kind: &str, title: String, body: String) {
        self.port.tell(
            "notify",
            &json!({"tab": run.tab, "notice": {"kind": kind, "title": title, "body": body}}),
        );
    }

    /// A run paused: the summary line goes to the runtime log always and to a notification unless the pause is the user's own
    /// doing or a state the screen already shows.
    async fn report_stop(self: &Arc<Self>, run: &Arc<Run>, reason: &str, detail: Option<&str>) {
        let (line, details) = self.summary(run, reason, detail).await;
        self.port
            .tell("runLog", &json!({"message": "paused", "details": details}));
        if SILENT_REASONS.contains(&reason) {
            return;
        }
        let kind = if COMPLETION_REASONS.contains(&reason) {
            "completion"
        } else {
            "error"
        };
        let title = self.text("autopilot.paused.title", json!({})).await;
        self.notify(run, kind, title, line);
    }

    /// One line that says what the run did and why it stopped: cycles (green), commits, whether they reached the default
    /// branch (landing), the pushed branch, or only this computer, and the reason. Read from the journal and git, so it is
    /// right after a relaunch too; it is the record that outlives the run's session.
    async fn summary(
        &self,
        run: &Arc<Run>,
        reason: &str,
        detail: Option<&str>,
    ) -> (String, serde_json::Map<String, Value>) {
        let status = match self.fetch_status(run).await {
            Ok(status) => Some(status),
            Err(_) => run.lock().status.clone(),
        };
        let cycles: Vec<Value> = status
            .as_ref()
            .and_then(|status| status.get("cycles"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let commits: Vec<String> = cycles
            .iter()
            .filter_map(|cycle| text(cycle, "commit"))
            .filter(|commit| !commit.is_empty())
            .map(str::to_owned)
            .collect();
        let green = cycles
            .iter()
            .filter(|cycle| text(cycle, "verify") == Some("green"))
            .count();
        let (root, remote, land_to, landing, branch, target, run_id, auto_push, auto_release, land) = {
            let state = run.lock();
            (
                state.root.clone(),
                state.settings.remote(),
                state.land_to.clone(),
                state.landing.clone(),
                state.branch.clone(),
                state.target.clone(),
                state.run.clone(),
                state.settings.auto_push(),
                state.settings.auto_release(),
                state.settings.land(),
            )
        };
        let git = self.git().await.ok();
        let contains = |reference: String, sha: String| {
            let (git, root) = (git.as_ref(), root.clone());
            async move {
                let Some(git) = git else { return false };
                contains_commit(git, &root, &reference, &sha).await
            }
        };
        let mut details = serde_json::Map::new();
        let shipped = if let (true, Some(dest)) = (land, land_to.clone()) {
            let reference = format!("refs/remotes/{remote}/{dest}");
            let mut landed = 0;
            for sha in &commits {
                if contains(reference.clone(), sha.clone()).await {
                    landed += 1;
                }
            }
            details.insert("landed".into(), json!(landed));
            details.insert("landTo".into(), json!(dest));
            let params = json!({"landed": landed, "commits": commits.len(), "target": dest,
                "url": landing.as_ref().and_then(|landing| text(landing, "url")).map_or(branch.clone(), str::to_owned)});
            let line = if landing.is_some() {
                self.text("autopilot.summary.pr", params).await
            } else {
                self.text(
                    "autopilot.summary.landed",
                    json!({"landed": landed, "commits": commits.len(), "target": dest}),
                )
                .await
            };
            if let Some(url) = landing.as_ref().and_then(|landing| text(landing, "url")) {
                details.insert("pr".into(), json!(url));
            }
            line
        } else if auto_push || auto_release {
            let dest = target.clone().unwrap_or_else(|| branch.clone());
            let pushed = match commits.last() {
                Some(last) => contains(format!("refs/remotes/{remote}/{dest}"), last.clone()).await,
                None => false,
            };
            details.insert("pushed".into(), json!(pushed));
            if pushed {
                self.text(
                    "autopilot.summary.pushed",
                    json!({"target": format!("{remote}/{dest}")}),
                )
                .await
            } else {
                self.text("autopilot.summary.notPushed", json!({})).await
            }
        } else {
            self.text("autopilot.summary.local", json!({})).await
        };
        let why = match reason_key(reason) {
            Some(key) => {
                self.text(key, json!({"detail": detail.unwrap_or_default()}))
                    .await
            }
            None => match detail {
                Some(detail) if !detail.is_empty() => format!("{reason}: {detail}"),
                _ => reason.to_owned(),
            },
        };
        let line = self
            .text(
                "autopilot.summary",
                json!({"branch": branch, "cycles": cycles.len(), "green": green, "commits": commits.len(), "shipped": shipped, "reason": why}),
            )
            .await;
        let mut all = serde_json::Map::new();
        all.insert("summary".into(), json!(line));
        all.insert("run".into(), json!(run_id));
        all.insert("root".into(), json!(root));
        all.insert("branch".into(), json!(branch));
        all.insert("reason".into(), json!(reason));
        if let Some(detail) = detail.filter(|detail| !detail.is_empty()) {
            all.insert("detail".into(), json!(detail));
        }
        all.insert("cycles".into(), json!(cycles.len()));
        all.insert("green".into(), json!(green));
        all.insert("commits".into(), json!(commits.len()));
        all.extend(details);
        (line, all)
    }
}

/// What git says of a run's worktree (see `RepoProbe`): only "no such file or folder" is absence; a refused, busy or
/// out-of-handles check says nothing.
pub async fn probe(git: &Git, root: &str) -> RepoProbe {
    if let Err(error) = std::fs::metadata(root) {
        let missing = error.kind() == std::io::ErrorKind::NotFound
            || (cfg!(unix) && error.raw_os_error() == Some(20));
        return if missing {
            RepoProbe::Gone
        } else {
            RepoProbe::Unknown
        };
    }
    match git.run(root, &["rev-parse", "--git-dir"], slow()).await {
        Ok(result) if result.code == 0 => RepoProbe::Present,
        Ok(result)
            if result
                .stderr
                .to_lowercase()
                .contains("not a git repository") =>
        {
            RepoProbe::Gone
        }
        _ => RepoProbe::Unknown,
    }
}

/// `git merge-base --is-ancestor <sha> <reference>` answered yes.
async fn contains_commit(git: &Git, root: &str, reference: &str, sha: &str) -> bool {
    git.run(
        root,
        &["merge-base", "--is-ancestor", sha, reference],
        slow(),
    )
    .await
    .is_ok_and(|output| output.code == 0)
}

/// `Promise.all` over the futures: all of them run, none is waited for before the others start.
async fn futures_join<F: Future<Output = ()>>(all: impl IntoIterator<Item = F>) {
    let mut pending: Vec<std::pin::Pin<Box<F>>> = all.into_iter().map(Box::pin).collect();
    std::future::poll_fn(|cx| {
        pending.retain_mut(|future| future.as_mut().poll(cx).is_pending());
        if pending.is_empty() {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autopilot::ship::{QueueItem, ShipResult};

    fn captured() -> Value {
        serde_json::from_str(include_str!("captured-run.json")).unwrap()
    }

    fn result(value: &Value) -> ShipResult {
        let item: QueueItem = serde_json::from_value(value["item"].clone()).unwrap();
        let land = value
            .get("land")
            .map(|land| match text(land, "kind").unwrap() {
                "landed" => ship::LandOutcome::Landed {
                    sha: "x".into(),
                    merge: None,
                },
                "pr" => ship::LandOutcome::Pr {
                    url: None,
                    created: true,
                    reason: String::new(),
                },
                "behind" => ship::LandOutcome::Behind {
                    ahead: None,
                    conflicts: None,
                },
                _ => ship::LandOutcome::Red {
                    candidate: String::new(),
                    onto: String::new(),
                    check: String::new(),
                    exit_code: None,
                    timed_out: false,
                    tail: String::new(),
                },
            });
        ShipResult {
            item,
            failure: None,
            pushed: None,
            land,
        }
    }

    #[test]
    fn what_kept_a_cycle_from_shipping_reads_as_the_typescript_said() {
        for case in captured()["gaps"].as_array().unwrap() {
            let results: Vec<ShipResult> = case["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(result)
                .collect();
            let own: Vec<String> = case["own"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_str().unwrap().to_owned())
                .collect();
            let out = ship_gap(&case["record"], &results, &own);
            assert_eq!(json!(out), case["out"], "{case}");
        }
    }

    #[test]
    fn the_nudges_are_the_four_messages_the_typescript_sent() {
        let constants = &captured()["constants"]["nudge"];
        for reason in ["no_progress", "plan", "blocked", "error"] {
            assert_eq!(json!(nudge_message(reason)), constants[reason], "{reason}");
        }
        assert_eq!(
            json!(RELEASE_NOW_MESSAGE),
            captured()["constants"]["releaseNow"]
        );
        assert_eq!(
            json!(STOP_AFTER_SHIP_NOTE),
            captured()["constants"]["stopAfterShip"]
        );
    }

    #[tokio::test]
    async fn a_checkout_is_present_and_a_missing_or_non_repository_folder_is_gone() {
        use crate::git::run::tests::git;
        let dir = crate::fs::disk::make_temp_dir("ompdesk-probe-test-").unwrap();
        let root = dir.to_string_lossy().into_owned();
        assert_eq!(
            probe(&git(), &format!("{root}/missing")).await,
            RepoProbe::Gone
        );
        let plain = dir.join("plain");
        std::fs::create_dir(&plain).unwrap();
        assert_eq!(
            probe(&git(), plain.to_str().unwrap()).await,
            RepoProbe::Gone
        );
        let repo = dir.join("repo");
        std::fs::create_dir(&repo).unwrap();
        let init = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&repo)
            .status()
            .unwrap();
        assert!(init.success());
        assert_eq!(
            probe(&git(), repo.to_str().unwrap()).await,
            RepoProbe::Present
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_folder_that_cannot_be_looked_at_is_unknown_never_gone() {
        use crate::git::run::tests::git;
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::fs::disk::make_temp_dir("ompdesk-probe-locked-").unwrap();
        let locked = dir.join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root can look into it (nothing to check then); a user that cannot says `unknown`, never `gone`.
        let blocked = std::fs::read_dir(&locked).is_err();
        let said = probe(&git(), locked.join("wt").to_str().unwrap()).await;
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _ = std::fs::remove_dir_all(dir);
        if blocked {
            assert_eq!(said, RepoProbe::Unknown);
        }
    }
}
