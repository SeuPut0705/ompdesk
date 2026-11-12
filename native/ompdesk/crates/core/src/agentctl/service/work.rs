//! Family 3, work: judging, merging, scheduling, Autopilot, the review board, auto-close and the app tools.
//!
//! This file: `#evidence`, `#compare`, `#judge`, `#merge`, `#mergeable`, `#runMerge` (service.ts 3936-4164). The
//! rest of the family is in `work/`:
//! - `review`: `#reviewItem`, `reviewItems`, `review`, `familyEdits`, `#closedEdits`, `liveReview`, `#cost`,
//!   `#split` (4166-4451) and the turn-edit cut of `src/shared/turn-edits.ts`.
//! - `auto`: `autoClose`, `#autoDone`, `#nudgeSilent`, `#autoCloseFacts`, `#tabRow`, `#transcript`,
//!   `#deleteThrowaway`, `#autoCloseTab` (4496-4796).
//! - `schedule`: `#schedule`, `#frequencyOf`, `#autopilot`, `#runStatus`, `#autopilotStart`, `#autopilotFrom`
//!   (4802-5108).
//! - `app`: `ServicePorts` (the `AppPorts` of this service), `#appControl`, `#appAutopilot`, `#rpcOn`,
//!   `#utilityTab`, `#closeUtilityTabs`, `#discardUtility` and the `T.app` / `T.appList` arms with `#appRuns`.
//!
//! Called of the other families (by these names): `close_tab`, `CloseHow`, `TabClose`, `remember_closed`, `fated`
//! (sessions); `journal_marks`, `report_fields`, `report` (messages).

mod app;
mod auto;
mod review;
mod schedule;
#[cfg(test)]
mod tests;

pub use app::{ServicePorts, command_timeout};

use serde_json::json;

use super::AgentControl;
use super::fail::{R, fail};
use super::host::Deadline;
use super::js::{cut, len16, number, one_line};
use super::text::{
    CheckRun, JudgeReply, bound_diff, checks_run, content_text, error_text, hook_failure,
    judge_label, label, merge_problem, parse_verdict, prediction_line, response_data, stored_title,
    transcript_page, waits,
};
use super::types::{AgentMessage, ControlTab, MergePrediction, StoredSession, Target, WorktreeRef};
use super::util::join;

/// Newest transcript messages a compare reads from an open session for the checks it ran.
pub(crate) const EVIDENCE_MESSAGES: usize = 200;
/// The judge request's evidence, all sessions together; each session gets an equal share.
const JUDGE_EVIDENCE_CHARS: usize = 60_000;
/// Newest checks per session whose output the judge reads.
const JUDGE_CHECKS: usize = 4;
/// The longest report a child's `done` can carry (`MESSAGE_MAX_CHARS` of `tools.ts`).
pub(crate) const MESSAGE_MAX_CHARS: usize = 50_000;
/// What a transcript read for evidence is given.
const EVIDENCE_READ_MS: u64 = 30_000;

const JUDGE_SYSTEM: &str = r#"You judge the work of several coding sessions against acceptance criteria, for the agent that started them.
Use only the evidence given: each session's state, the checks it ran (command, outcome and the end of its output, read from its transcript), its git diff against where it would land, a prediction of merging it, and its final answer.
Read the diff yourself. A criterion no hunk implements is "no" even when the final answer claims it. A change that removes or alters behaviour no criterion asked for is a regression: name it in reasons and lower the score. A predicted merge conflict counts against the session.
A claim that no check or diff supports counts as "unknown", not "yes". A failed check counts against the criterion it covers. A session that is still running cannot be the winner.
Answer with JSON only, no prose around it:
{"ranking":[{"session":"<id>","score":<0-100>,"criteria":[{"criterion":"<text>","met":"yes|partly|no|unknown","why":"<short evidence>"}],"reasons":"<one or two sentences>"}],"winner":"<id or null>","why":"<why it wins, or why none does>"}
Rank every session, best first. Pick a winner only if it meets every criterion at least partly and beats the others on the evidence."#;

/// What a compare reads from one session: its final answer, the checks it ran and its worktree's diff.
struct Evidence {
    id: String,
    text: String,
    facts: String,
    answer: Option<String>,
    checks: Vec<CheckRun>,
    /// The worktree's diff against where it lands, already cut by its git; "" without a worktree.
    diff: String,
    diff_omitted: f64,
}

impl AgentControl {
    /// `#evidence`.
    async fn evidence(
        &self,
        caller: &ControlTab,
        target: &Target,
        diff_chars: usize,
    ) -> R<Evidence> {
        let (open, stored): (Option<&ControlTab>, Option<&StoredSession>) = match target {
            Target::Tab(tab) => (Some(tab), None),
            Target::Stored(row) => (None, Some(row)),
        };
        match (open, stored) {
            (Some(tab), _) => self.refuse_hidden(tab, caller)?,
            (None, Some(row)) if row.hidden => {
                return fail("The user hid a session you asked to compare from other agents.");
            }
            _ => {}
        }
        let id = open.map_or_else(
            || stored.map(|row| row.id.clone()).unwrap_or_default(),
            |tab| tab.tab_id.clone(),
        );
        let name = match (open, stored) {
            (Some(tab), _) => label(tab),
            (None, Some(row)) => format!("\"{}\" (saved)", one_line(&stored_title(row), 80)),
            _ => String::new(),
        };
        let mut messages: Vec<AgentMessage> = Vec::new();
        let mut state = "saved, not open".to_owned();
        let answer: Option<String>;
        if let Some(tab) = open {
            let session = self.session_state(tab).await;
            state = self.state_line(&self.host.state(), tab, &session);
            answer = session.last.clone();
            if tab.status.is_up() {
                let page = self
                    .host
                    .command(
                        &tab.tab_id,
                        &json!({ "type": "get_transcript_page", "fromEnd": true, "limit": EVIDENCE_MESSAGES }),
                        Deadline::Ms(EVIDENCE_READ_MS),
                    )
                    .await
                    .ok()
                    .filter(|response| response.success)
                    .and_then(|response| response.data)
                    .and_then(|data| transcript_page(&data));
                messages = page.map(|page| page.messages).unwrap_or_default();
            }
        } else if let Some(row) = stored {
            messages = self.host.stored_messages(row).await?;
            answer = messages
                .iter()
                .rev()
                .find(|message| message.role == "assistant")
                .and_then(|last| {
                    let text = content_text(last.content.as_ref());
                    let text = super::js::trim(&text);
                    (!text.is_empty()).then(|| text.to_owned())
                });
        } else {
            answer = None;
        }
        let checks = checks_run(&messages);
        let check_line = if checks.is_empty() {
            "checks run: none seen in its transcript".to_owned()
        } else {
            format!(
                "checks run: {}",
                checks[checks.len().saturating_sub(8)..]
                    .iter()
                    .map(|check| format!(
                        "`{}` {}",
                        one_line(&check.command, 100),
                        if check.passed { "passed" } else { "FAILED" }
                    ))
                    .collect::<Vec<_>>()
                    .join("; ")
            )
        };
        let mut lines = vec![format!("- {id} {name}: {state}"), format!("  {check_line}")];
        let worktree = open.and_then(|tab| tab.worktree.as_ref());
        let device = open.and_then(|tab| tab.device.as_deref());
        let mut diff = String::new();
        let mut diff_omitted = 0.0;
        match worktree {
            None => lines.push("  no worktree: no branch to diff".to_owned()),
            Some(worktree) => {
                let worktree = worktree.reference();
                let (facts, read) = tokio::join!(
                    self.host.branch_facts(&worktree, device),
                    self.host.branch_evidence(&worktree, diff_chars, device),
                );
                let facts = facts.map_err(|error| error_text(&error));
                let read = read.map_err(|error| error_text(&error));
                match &facts {
                    Err(reason) => lines.push(format!("  could not read its branch: {reason}")),
                    Ok(facts) => {
                        let added: f64 = facts.files.iter().map(|file| file.added).sum();
                        let removed: f64 = facts.files.iter().map(|file| file.removed).sum();
                        let shown = facts
                            .files
                            .iter()
                            .take(12)
                            .map(|file| {
                                format!(
                                    "{} +{} −{}",
                                    file.path,
                                    number(file.added),
                                    number(file.removed)
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(", ");
                        let more = if facts.files.len() > 12 {
                            format!(", … {} more", facts.files.len() - 12)
                        } else {
                            String::new()
                        };
                        let to_merge = !facts.merged && facts.commits_ahead > 0.0;
                        let prediction = match &read {
                            Err(reason) => MergePrediction::Unknown {
                                reason: reason.clone(),
                            },
                            Ok(read) => read.merge.clone(),
                        };
                        if let Some(tab) = open {
                            let mut mem = self.mem();
                            match &prediction {
                                MergePrediction::Conflict { files } if to_merge => {
                                    mem.conflicts.insert(tab.tab_id.clone(), files.clone());
                                }
                                MergePrediction::Clean => {
                                    mem.conflicts.remove(&tab.tab_id);
                                }
                                _ => {}
                            }
                        }
                        let problem = merge_problem(&worktree, facts).or_else(|| {
                            (to_merge && matches!(prediction, MergePrediction::Conflict { .. }))
                                .then(|| {
                                    format!(
                                        "merging would conflict; ask that session to merge {} into its branch and resolve the conflicts, then compare again.",
                                        facts.base_branch.as_deref().unwrap_or("undefined")
                                    )
                                })
                        });
                        lines.push(format!(
                            "  branch {} → {}: {} commit(s) ahead, {} file(s) changed (+{} −{}){}",
                            facts.branch,
                            facts.base_branch.as_deref().unwrap_or("(detached)"),
                            number(facts.commits_ahead),
                            facts.files.len(),
                            number(added),
                            number(removed),
                            if facts.merged { ", already merged" } else { "" }
                        ));
                        lines.push(format!(
                            "  uncommitted {}, untracked {}{}",
                            number(facts.uncommitted),
                            number(facts.untracked),
                            if shown.is_empty() {
                                String::new()
                            } else {
                                format!("\n  files: {shown}{more}")
                            }
                        ));
                        if to_merge {
                            lines.push(format!(
                                "  {}",
                                prediction_line(&prediction, facts.base_branch.as_deref())
                            ));
                        }
                        lines.push(format!(
                            "  {}",
                            match problem {
                                Some(problem) => format!("cannot merge yet: {problem}"),
                                None => "ready to merge with ompdesk_merge".to_owned(),
                            }
                        ));
                    }
                }
                if let Ok(read) = read {
                    diff = read.diff;
                    diff_omitted = read.diff_omitted;
                }
            }
        }
        let facts = lines[1..].join("\n");
        lines.push(format!(
            "  final answer: {}",
            match answer.as_deref().filter(|answer| !answer.is_empty()) {
                Some(answer) => one_line(answer, 700),
                None => "(none yet)".to_owned(),
            }
        ));
        Ok(Evidence {
            id,
            text: lines.join("\n"),
            facts,
            answer,
            checks,
            diff,
            diff_omitted,
        })
    }

    /// `ompdesk_compare`: each session's evidence (final answer, checks from its transcript, worktree diff and merge
    /// prediction); with criteria, one judge request on the caller's omp (stock's advisor chain, then slow, a model
    /// of another family than the caller's when one has credentials) grades them and names a winner. A failed judge
    /// leaves the evidence with `Verdict: unavailable`. Runs no tests.
    pub(crate) async fn compare(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        sessions: Option<Vec<String>>,
        criteria: Option<Vec<String>>,
    ) -> R<String> {
        let own = self.opened_by(&self.host.state(), &caller.tab_id, tabs);
        let targets: Vec<Target> = match &sessions {
            Some(ids) => join::all(
                ids.iter()
                    .map(|id| join::boxed(self.resolve_any(tabs, id, caller, "compare", None)))
                    .collect(),
            )
            .await
            .into_iter()
            .collect::<R<Vec<Target>>>()?,
            None => tabs
                .iter()
                .filter(|tab| own.contains(&tab.tab_id) && tab.worktree.is_some())
                .map(|tab| Target::Tab(Box::new(tab.clone())))
                .collect(),
        };
        if targets.is_empty() {
            return fail(
                "No worktree sessions to compare. Open sessions with worktree: true, or pass sessions.",
            );
        }
        let diff_chars = if criteria.is_some() {
            JUDGE_EVIDENCE_CHARS / targets.len()
        } else {
            0
        };
        let evidence = join::all(
            targets
                .iter()
                .map(|target| join::boxed(self.evidence(caller, target, diff_chars)))
                .collect(),
        )
        .await
        .into_iter()
        .collect::<R<Vec<Evidence>>>()?;
        {
            let mut mem = self.mem();
            for target in &targets {
                if let Target::Tab(tab) = target {
                    mem.collected.insert(tab.tab_id.clone());
                }
            }
        }
        let blocks = evidence
            .iter()
            .map(|entry| entry.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let Some(criteria) = criteria else {
            return Ok(format!(
                "{blocks}\nCompare runs no tests: ask each session to run them (ompdesk_session_send) and read its answer. Pass criteria to have them judged."
            ));
        };
        let verdict = match self.judge(caller, &evidence, &criteria).await {
            Ok(verdict) => verdict,
            Err(error) => format!(
                "Verdict: unavailable ({}). Judge the evidence below yourself or compare again.",
                one_line(&error_text(&error), 400)
            ),
        };
        Ok(format!("{verdict}\n\nEvidence:\n{blocks}"))
    }

    /// `#judge`.
    async fn judge(
        &self,
        caller: &ControlTab,
        evidence: &[Evidence],
        criteria: &[String],
    ) -> R<String> {
        let per = JUDGE_EVIDENCE_CHARS / evidence.len();
        let session = |entry: &Evidence| -> String {
            let answer_room = 500.max((per as f64 * 0.2).floor() as usize);
            let answer = cut(entry.answer.as_deref().unwrap_or("(none)"), answer_room);
            let mut checks_left = (per as f64 * 0.15).floor() as usize;
            let mut checks: Vec<String> = Vec::new();
            let newest = &entry.checks[entry.checks.len().saturating_sub(JUDGE_CHECKS)..];
            for check in newest.iter().rev() {
                let block = format!(
                    "$ {} → {}\n{}",
                    one_line(&check.command, 200),
                    if check.passed { "passed" } else { "FAILED" },
                    check.tail
                );
                if len16(&block) > checks_left {
                    break;
                }
                checks_left -= len16(&block);
                checks.insert(0, block);
            }
            let used = len16(&entry.facts) + len16(&answer) + len16(&checks.join("\n")) + 200;
            let room = per.saturating_sub(used);
            let (bounded_text, bounded_omitted) = if len16(&entry.diff) > room {
                bound_diff(&entry.diff, room)
            } else {
                (entry.diff.clone(), 0)
            };
            let omitted = entry.diff_omitted + bounded_omitted as f64;
            let mut lines = vec![
                format!("<session id=\"{}\">", entry.id),
                entry.facts.clone(),
            ];
            if !checks.is_empty() {
                lines.push("check output (newest last):".to_owned());
                lines.extend(checks);
            }
            lines.push("final answer:".to_owned());
            lines.push(answer);
            if !bounded_text.is_empty() {
                lines.push(format!(
                    "diff{}:",
                    if omitted != 0.0 {
                        format!(" ({} characters left out)", number(omitted))
                    } else {
                        String::new()
                    }
                ));
                lines.push(bounded_text);
            } else if !entry.diff.is_empty() || omitted != 0.0 {
                lines.push(format!("diff: {} characters, none fit", number(omitted)));
            }
            lines.push("</session>".to_owned());
            lines.join("\n")
        };
        let mut user_lines = vec!["Acceptance criteria:".to_owned()];
        user_lines.extend(
            criteria
                .iter()
                .enumerate()
                .map(|(index, criterion)| format!("{}. {criterion}", index + 1)),
        );
        user_lines.push(String::new());
        user_lines.extend(evidence.iter().map(session));
        let response = self
            .host
            .command(
                &caller.tab_id,
                &json!({ "type": "agent_control_judge", "system": JUDGE_SYSTEM, "user": user_lines.join("\n") }),
                Deadline::Ms(self.tuning.judge_ms),
            )
            .await?;
        let data = response_data(&response, "Judging")?;
        let reply: Option<JudgeReply> = if data.is_null() {
            None
        } else {
            serde_json::from_value(data).ok()
        };
        let text = reply.as_ref().and_then(|reply| reply.text.as_deref());
        let cost = format!(
            "{}{}",
            judge_label(reply.as_ref()),
            match reply.as_ref().and_then(|reply| reply.usd) {
                Some(usd) => format!(", ${usd:.4}"),
                None => String::new(),
            }
        );
        let Some(parsed) = parse_verdict(text.unwrap_or("")) else {
            return Ok(format!(
                "Judge{cost} (its answer was not the expected JSON):\n{}",
                cut(text.unwrap_or(""), 4000)
            ));
        };
        let known: std::collections::HashSet<&str> =
            evidence.iter().map(|entry| entry.id.as_str()).collect();
        let mut ranking: Vec<_> = parsed
            .ranking
            .iter()
            .filter(|row| known.contains(row.session.as_str()))
            .collect();
        ranking.sort_by(|a, b| b.score.total_cmp(&a.score));
        let mut lines = vec![format!("Verdict{cost}:")];
        for (index, row) in ranking.iter().enumerate() {
            lines.push(format!(
                "{}. {}: {}/100. {}",
                index + 1,
                row.session,
                number(row.score),
                one_line(&row.reasons, 400)
            ));
            for item in &row.criteria {
                lines.push(format!(
                    "   - {}: {}{}",
                    item.met,
                    one_line(&item.criterion, 120),
                    if item.why.is_empty() {
                        String::new()
                    } else {
                        format!(" ({})", one_line(&item.why, 200))
                    }
                ));
            }
        }
        lines.push(match parsed.winner.as_deref() {
            Some(winner) if !winner.is_empty() && known.contains(winner) => {
                format!("Winner: {winner}. {}", one_line(&parsed.why, 500))
            }
            _ => format!(
                "No winner: {}",
                one_line(
                    if parsed.why.is_empty() {
                        "none meets the criteria"
                    } else {
                        &parsed.why
                    },
                    500
                )
            ),
        });
        Ok(lines.join("\n"))
    }

    /// `ompdesk_merge` of `target`, resolved by `open` (`#merge`): a worktree session's branch into the parent
    /// checkout, one card unless the user turned it off.
    pub(crate) async fn merge(&self, caller: &ControlTab, target: &ControlTab) -> R<String> {
        let worktree = self.mergeable(caller, target)?;
        let facts = self
            .host
            .branch_facts(&worktree, target.device.as_deref())
            .await?;
        if let Some(problem) = merge_problem(&worktree, &facts) {
            return fail(problem);
        }
        let state = self.host.state();
        if !state.manage_enabled {
            let caller_name = if caller.title.is_empty() {
                "—"
            } else {
                caller.title.as_str()
            };
            let target_name = if target.title.is_empty() {
                target.tab_id.as_str()
            } else {
                target.title.as_str()
            };
            let approved = self
                .host
                .confirm(
                    &caller.tab_id,
                    &state.text("mergeTitle", &[]),
                    &state.text(
                        "mergeMessage",
                        &[
                            ("caller", caller_name),
                            ("target", target_name),
                            ("branch", &worktree.branch),
                            ("base", facts.base_branch.as_deref().unwrap_or("")),
                            ("cwd", &worktree.base_cwd),
                        ],
                    ),
                )
                .await?;
            if !approved {
                return Ok(format!(
                    "The user declined the merge of {}. Do not ask again unless they tell you to.",
                    worktree.branch
                ));
            }
        }
        self.run_merge(target, &worktree).await
    }

    /// `#mergeable`.
    fn mergeable(&self, caller: &ControlTab, target: &ControlTab) -> R<WorktreeRef> {
        self.refuse_hidden(target, caller)?;
        let Some(worktree) = &target.worktree else {
            return fail(format!(
                "{} has no worktree branch to merge (open sessions with worktree: true).",
                label(target)
            ));
        };
        if target.busy || waits(target) {
            return fail(format!(
                "{} is still working or waiting; collect its result first.",
                label(target)
            ));
        }
        Ok(worktree.reference())
    }

    /// `#runMerge`.
    async fn run_merge(&self, target: &ControlTab, worktree: &WorktreeRef) -> R<String> {
        let outcome = self
            .host
            .merge_branch(worktree, &target.title, target.device.as_deref())
            .await?;
        if !outcome.merged {
            if outcome.reason.as_deref() == Some("hook")
                && let Some(hook) = &outcome.hook
            {
                return fail(format!(
                    "Pre-merge hook {} in {}; the merge was not started. Output tail:\n{}\nLog: {}",
                    hook_failure(hook),
                    worktree.path,
                    hook.output_tail,
                    hook.log_path
                ));
            }
            self.mem()
                .conflicts
                .insert(target.tab_id.clone(), outcome.files.clone());
            let ask = format!(
                "Ask {} to merge the parent's branch into its own and resolve, then try again.",
                label(target)
            );
            let files = outcome.files.join(", ");
            return fail(if outcome.predicted {
                format!(
                    "Merging {} would conflict in {files} (predicted by git merge-tree): no merge was attempted and {} is unchanged. {ask}",
                    worktree.branch, worktree.base_cwd
                )
            } else {
                format!(
                    "Merge conflict in {files}: the merge was aborted and {} is unchanged. {ask}",
                    worktree.base_cwd
                )
            });
        }
        {
            let mut mem = self.mem();
            mem.conflicts.remove(&target.tab_id);
            mem.reviewed.insert(target.tab_id.clone());
            mem.collected.insert(target.tab_id.clone());
        }
        let post = match &outcome.post_merge {
            Some(hook) => format!(
                " Post-merge hook {}; the merge stays. Output tail:\n{}\nLog: {}",
                hook_failure(hook),
                hook.output_tail,
                hook.log_path
            ),
            None => String::new(),
        };
        Ok(format!(
            "Merged {} into {} ({}{}). Nothing was pushed.{post}",
            worktree.branch,
            worktree.base_cwd,
            outcome.sha.as_deref().unwrap_or(""),
            match outcome.summary.as_deref() {
                Some(summary) if !summary.is_empty() => format!(": {summary}"),
                _ => String::new(),
            }
        ))
    }
}
