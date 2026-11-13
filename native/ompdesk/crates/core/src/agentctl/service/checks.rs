//! `ompdesk_checks`: start, wait for and read checks through the checks hub of this process (`crate::checks`). The
//! body decides nothing: who asks is this service's word (`origin_of`), the hub answers, and the texts here say the
//! hub's answer in the words an agent acts on. A wait is the hub's, so it polls nothing; like `ompdesk_session_result`
//! it returns early when a message reaches the caller. A result whose session is not inside a wait for it is brought
//! to that session as a waking note (`follow_checks`).

use std::sync::Arc;

use tokio::sync::broadcast::error::RecvError;

use super::AgentControl;
use super::fail::{R, fail};
use super::text::saved_id_of_path;
use super::types::{ChecksArgs, ControlTab};
use crate::aimemory::value::iso;
use crate::checks::contract::{
    Answer, AnswerVerdict, JobState, Next, Origin, Purpose, Run, RunResult, Snapshot,
    StartDecision, StartReply, StartRequest, StartScope, StatusRequest, StatusScope, Until,
    WaitRequest, Where,
};
use crate::checks::hub::ChecksHub;
use crate::server::Scope;

const UNAVAILABLE: &str = "Check control is not available in this OMPdesk yet. Run checks as the repository's rules say (its CI script), and wait for a run once with a backgrounded watch.";

/// Who asks, from what main says of the caller: its session, or the outside process's own name.
pub fn origin_of(caller: &ControlTab) -> Origin {
    if let Some(rest) = caller.tab_id.strip_prefix("outside:") {
        return Origin::Outside {
            claimed_name: rest.split('#').next().unwrap_or(rest).to_owned(),
        };
    }
    Origin::Session {
        session: saved_id_of_path(caller.session_path.as_deref())
            .unwrap_or_else(|| caller.tab_id.clone()),
        device: caller
            .device
            .clone()
            .filter(|device| !device.is_empty())
            .unwrap_or_else(|| "local".into()),
        goal: None,
    }
}

fn place(place: &Where) -> String {
    match place {
        Where::GithubHosted => "a GitHub-hosted runner".into(),
        Where::SelfHosted { runner_id } => format!("the self-hosted runner {runner_id}"),
        Where::Device { device_id } if device_id == "local" => "this computer".into(),
        Where::Device { device_id } => format!("the computer {device_id}"),
    }
}

fn minutes(ms: u64) -> String {
    format!("{} min", ms.div_ceil(60_000))
}

fn wait_call(run: &str) -> String {
    format!("ompdesk_checks {{\"op\":\"wait\",\"run\":\"{run}\"}}")
}

/// A start's reply. The first line names the decision (the CLI's exit code reads it).
pub fn start_text(reply: &StartReply) -> String {
    let run = reply.run_id.as_deref().unwrap_or("");
    let mut lines = vec![match reply.decision {
        StartDecision::Started => format!("Checks started: run {run}."),
        StartDecision::Reused => {
            format!("Checks reused: run {run} already covers these inputs, nothing was started.")
        }
        StartDecision::Held => {
            format!("Checks held: run {run} waits in OMPdesk's queue and starts by itself.")
        }
        StartDecision::Refused => "Checks refused: nothing was started.".to_owned(),
    }];
    let mut facts = Vec::new();
    if let Some(placement) = &reply.placement {
        facts.push(format!("Where: {}", place(placement)));
    }
    if let Some(expected) = reply.expected_start_min {
        facts.push(format!("expected start in about {expected} min"));
    }
    if !facts.is_empty() {
        lines.push(format!("{}.", facts.join(", ")));
    }
    if !reply.reason.is_empty() {
        lines.push(format!("Why: {}", reply.reason));
    }
    if reply.decision != StartDecision::Refused && !run.is_empty() {
        lines.push(format!(
            "Next: {} ends when the result arrives. Never poll gh for it; if you end your turn instead, you are woken with the result.",
            wait_call(run)
        ));
    }
    lines.join("\n")
}

/// An answer as the agent reads it. The first line names the verdict (the CLI's exit code reads it).
pub fn answer_text(answer: &Answer) -> String {
    let verdict = match answer.verdict {
        AnswerVerdict::Green => "green",
        AnswerVerdict::Red => "red",
        AnswerVerdict::Unknown => "unknown",
    };
    let mut lines = vec![format!(
        "Run {}: {verdict} (as of {}).",
        answer.run_id,
        iso(answer.as_of)
    )];
    if answer.verdict != AnswerVerdict::Unknown || answer.counts.passed + answer.counts.failed > 0 {
        lines.push(format!(
            "{} passed, {} failed.",
            answer.counts.passed, answer.counts.failed
        ));
    }
    if !answer.failed.is_empty() {
        lines.push("Failed:".to_owned());
        for failed in &answer.failed {
            let flaky = if failed.known_flaky {
                "known flaky"
            } else {
                "not known flaky"
            };
            let history = if failed.history.is_empty() {
                String::new()
            } else {
                format!(": {}", failed.history)
            };
            lines.push(format!(
                "- {}\n  {}\n  ({flaky}{history})",
                failed.test, failed.first_error
            ));
        }
    }
    if let Some(blocks) = &answer.blocks_release {
        lines.push(format!("Blocks the release gate {}.", blocks.gate));
    } else if answer.verdict == AnswerVerdict::Red {
        lines.push("Blocks no release gate.".to_owned());
    }
    if let Some(expected) = answer.expected_wait_min {
        lines.push(format!("Expected wait: about {expected} min."));
    }
    if let Some(reused) = &answer.reused {
        lines.push(format!(
            "Reused from run {} (saved about {} min).",
            reused.from, reused.saved_min
        ));
    }
    lines.push(match answer.next {
        Next::Fix => "Next: fix the failures, then start the checks again.".to_owned(),
        Next::RerunFailed => {
            "Next: rerun only what failed: ompdesk_checks {\"op\":\"start\",\"rerun\":\"failed\"}."
                .to_owned()
        }
        Next::Wait => format!(
            "Next: no result yet: {} again, or end your turn and be woken with it.",
            wait_call(&answer.run_id)
        ),
        Next::Land => "Next: land it.".to_owned(),
        Next::AskOwner => "Next: this decision is the owner's: ask the user.".to_owned(),
    });
    for note in &answer.notes {
        lines.push(format!("Note: {note}"));
    }
    lines.join("\n")
}

fn who(origin: &Origin, me: &Origin) -> String {
    match origin {
        _ if origin == me => "you".into(),
        Origin::Session {
            session, device, ..
        } if device == "local" => format!("session {session}"),
        Origin::Session {
            session, device, ..
        } => format!("session {session} on {device}"),
        Origin::Person => "a person".into(),
        Origin::Outside { claimed_name } => {
            format!("outside process \"{claimed_name}\" (self-declared)")
        }
        Origin::Foreign => "another repository or program".into(),
    }
}

fn run_line(run: &Run, me: &Origin) -> String {
    let mut jobs = Vec::new();
    for state in JobState::ALL {
        let count = run.jobs.iter().filter(|job| job.state == *state).count();
        if count > 0 {
            jobs.push(format!("{count} {}", state.word()));
        }
    }
    let mut line = format!(
        "- {} · {} {} @{} · lane {} · started by {}",
        run.id,
        run.repo,
        run.git_ref,
        run.sha.get(..7).unwrap_or(&run.sha),
        run.lane.word(),
        who(&run.origin, me)
    );
    if !jobs.is_empty() {
        line.push_str(&format!(" · jobs: {}", jobs.join(", ")));
    }
    if let Some(verdict) = run.verdict {
        line.push_str(&format!(" · verdict {}", verdict.word()));
    }
    if let Some(gate) = &run.gate {
        line.push_str(&format!(" · release gate {gate}"));
    }
    line
}

/// The hub's cache as an agent reads it: pools first, so "is macOS full" is answered at a glance.
pub fn status_text(snapshot: &Snapshot, me: &Origin) -> String {
    let mut lines = vec![format!(
        "Checks as of {}{}.",
        iso(snapshot.as_of),
        if snapshot.paused {
            " (the owner paused admission: every start is refused)"
        } else {
            ""
        }
    )];
    if snapshot.pools.is_empty() {
        lines.push("Pools: none known.".to_owned());
    } else {
        lines.push("Pools:".to_owned());
        for pool in &snapshot.pools {
            let mut line = format!(
                "- {} ({}, {}): {} of {} running, {} queued",
                pool.id,
                pool.os.word(),
                place(&pool.place),
                pool.running,
                pool.limit,
                pool.queued
            );
            if pool.queued > 0 {
                line.push_str(&format!(", oldest wait {}", minutes(pool.oldest_wait_ms)));
            }
            if let Some(free) = pool.disk_free_gb {
                line.push_str(&format!(", {free:.0} GB free"));
            }
            if pool.state != crate::checks::contract::PoolState::Live {
                line.push_str(&format!(
                    " [{} since {}]",
                    pool.state.word(),
                    iso(pool.as_of)
                ));
            }
            lines.push(line);
        }
    }
    if snapshot.runs.is_empty() {
        lines.push("Runs: none.".to_owned());
    } else {
        lines.push("Runs:".to_owned());
        lines.extend(snapshot.runs.iter().map(|run| run_line(run, me)));
    }
    if !snapshot.gates.is_empty() {
        lines.push("Release gates:".to_owned());
        for gate in &snapshot.gates {
            lines.push(format!(
                "- {} ({}): {}{}",
                gate.gate.id,
                gate.gate.release,
                gate.state.word(),
                gate.run
                    .as_ref()
                    .map(|run| format!(", decided by {run}"))
                    .unwrap_or_default()
            ));
        }
    }
    lines.join("\n")
}

/// A session inside a wait for a run; counted until this drops, so its result is the wait's to deliver.
struct Waiting<'a>(&'a AgentControl, String, String);

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        let mut mem = self.0.mem();
        if let Some(runs) = mem.checks_waiting.get_mut(&self.1) {
            if let Some(at) = runs.iter().position(|run| run == &self.2) {
                runs.swap_remove(at);
            }
            if runs.is_empty() {
                mem.checks_waiting.remove(&self.1);
            }
        }
    }
}

impl AgentControl {
    fn checks_hub(&self) -> Option<Arc<dyn ChecksHub>> {
        let hub = crate::checks::hub(*self.checks.get()?)?;
        self.follow_checks(&hub);
        Some(hub)
    }

    /// `ompdesk_checks`.
    pub(in crate::agentctl::service) async fn checks_tool(
        &self,
        caller: &ControlTab,
        args: ChecksArgs,
    ) -> R<String> {
        let Some(hub) = self.checks_hub() else {
            return fail(UNAVAILABLE);
        };
        let origin = origin_of(caller);
        let cwd = Some(caller.cwd.clone()).filter(|cwd| !cwd.is_empty());
        match args.op.as_str() {
            "start" => {
                let request = StartRequest {
                    purpose: args.purpose.unwrap_or(Purpose::Branch),
                    scope: match args.scope.as_deref() {
                        Some("full") => StartScope::Full,
                        _ => StartScope::Changed,
                    },
                    rerun: args.rerun,
                    repo: args.repo,
                    git_ref: args.git_ref,
                    cwd,
                    workflow: args.workflow,
                };
                match hub.start(origin, request).await {
                    Ok(reply) => Ok(start_text(&reply)),
                    Err(fault) => fail(fault.message),
                }
            }
            "wait" => {
                let Some(run_id) = args.run else {
                    return fail("ompdesk_checks wait needs run (the id a start answered).");
                };
                let request = WaitRequest {
                    run_id: run_id.clone(),
                    until: args.until.unwrap_or(Until::Result),
                    timeout_seconds: args.timeout_seconds,
                };
                self.checks_wait(caller, &hub, origin, request).await
            }
            "status" => {
                let request = StatusRequest {
                    scope: match args.scope.as_deref() {
                        Some("repo") => StatusScope::Repo,
                        Some("all") => StatusScope::All,
                        _ => StatusScope::Mine,
                    },
                    repo: args.repo,
                    cwd,
                };
                match hub.status(origin.clone(), request).await {
                    Ok(snapshot) => Ok(status_text(&snapshot, &origin)),
                    Err(fault) => fail(fault.message),
                }
            }
            other => fail(format!(
                "ompdesk_checks has no op \"{other}\" (start, wait, status)."
            )),
        }
    }

    async fn checks_wait(
        &self,
        caller: &ControlTab,
        hub: &Arc<dyn ChecksHub>,
        origin: Origin,
        request: WaitRequest,
    ) -> R<String> {
        let run_id = request.run_id.clone();
        // Inside a blocking wait main owns, the caller cannot read a steer until the call returns.
        let _blocked = self.block(&caller.tab_id);
        self.mem()
            .checks_waiting
            .entry(caller.tab_id.clone())
            .or_default()
            .push(run_id.clone());
        let _waiting = Waiting(self, caller.tab_id.clone(), run_id.clone());
        let arrived_before = self.arrivals(&caller.tab_id);
        let scope = Scope::detached();
        let wait = hub.wait(origin, request, scope.clone());
        tokio::pin!(wait);
        loop {
            // Made before the count is read, so an arrival in between still wakes this.
            let arrived = self.arrived.notified();
            tokio::pin!(arrived);
            arrived.as_mut().enable();
            if self.arrivals(&caller.tab_id) > arrived_before {
                scope.cancel();
                return Ok(format!(
                    "Returned early: a message reached you while you waited (a steer or a report), so you read it at your next step. Run {run_id} has no result yet; {} again to keep waiting.",
                    wait_call(&run_id)
                ));
            }
            tokio::select! {
                answer = &mut wait => {
                    return match answer {
                        Ok(answer) => {
                            if answer.verdict != AnswerVerdict::Unknown {
                                self.mem().checks_told.insert((caller.tab_id.clone(), run_id));
                            }
                            Ok(answer_text(&answer))
                        }
                        Err(fault) => fail(fault.message),
                    };
                }
                () = &mut arrived => {}
            }
        }
    }

    /// Brings every result of `hub` to the session that started its run, unless that session is inside a wait for it
    /// (the wait answers it) or was already told. Runs once, for as long as the hub and this service live.
    pub fn follow_checks(&self, hub: &Arc<dyn ChecksHub>) {
        if std::mem::replace(&mut self.mem().checks_followed, true) {
            return;
        }
        let mut results = hub.results();
        let control = self.clone();
        let port = self.host.port().clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    result = results.recv() => match result {
                        Ok(result) => control.check_arrived(&result).await,
                        // Results it fell behind on are still in the hub's snapshot (`status`).
                        Err(RecvError::Lagged(_)) => {}
                        Err(RecvError::Closed) => return,
                    },
                    () = port.until_closed() => return,
                }
            }
        });
    }

    async fn check_arrived(&self, result: &RunResult) {
        let Origin::Session {
            session, device, ..
        } = &result.origin
        else {
            return;
        };
        let tab_id = {
            let state = self.host.state();
            state
                .tabs
                .iter()
                .find(|tab| {
                    let saved = saved_id_of_path(tab.session_path.as_deref());
                    let on = tab
                        .device
                        .as_deref()
                        .filter(|device| !device.is_empty())
                        .unwrap_or("local");
                    on == device
                        && (saved.as_deref() == Some(session.as_str()) || &tab.tab_id == session)
                })
                .map(|tab| tab.tab_id.clone())
        };
        // A session with no open tab reads it from `status` when it is back.
        let Some(tab_id) = tab_id else { return };
        let key = (tab_id.clone(), result.run_id.clone());
        {
            let mem = self.mem();
            let waiting = mem
                .checks_waiting
                .get(&tab_id)
                .is_some_and(|runs| runs.contains(&result.run_id));
            if waiting || mem.checks_told.contains(&key) {
                return;
            }
        }
        let text = format!(
            "The checks you started have a result (OMPdesk's check control; nobody polled for it).\n{}",
            answer_text(&result.answer)
        );
        let id = format!("check-result-{}", result.run_id);
        if self.host.tell_sender(&tab_id, None, &text, &id).await {
            self.mem().checks_told.insert(key);
            self.arrive(&tab_id);
        }
    }
}
