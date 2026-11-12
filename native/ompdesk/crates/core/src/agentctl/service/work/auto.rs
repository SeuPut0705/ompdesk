//! Closing what an opener started once its work landed: `autoClose`, `#autoDone`, `#nudgeSilent`,
//! `#autoCloseFacts`, `#autoCloseTab`, with `#tabRow`, `#transcript` and `#deleteThrowaway`.

use serde_json::{Value, json};

use super::super::AgentControl;
use super::super::Nudge;
use super::super::fail::R;
use super::super::host::Deadline;
use super::super::js::{cut, trim};
use super::super::sessions::{CloseHow, TabClose};
use super::super::text::{TranscriptEnding, label, transcript_ending, transcript_page, waits};
use super::super::types::{
    AgentMessage, ClosedChild, ControlTab, ReportArgs, SessionStateInfo, StoredSession, TabStatus,
};
use super::{EVIDENCE_MESSAGES, MESSAGE_MAX_CHARS};
use crate::agentctl::journal::session_fates::fate_by;
use crate::agentctl::rules::auto_close::{
    AutoCloseDecision, AutoCloseFacts, BranchLanding, Ended, Verdict, auto_close_decision,
};
use crate::agentctl::rules::mail::{MailDelivery, MailKind, delivery_for};
use crate::agentctl::rules::pickup::{WorkerResult, parse_worker_result};
use crate::agentctl::rules::tab_close::{TabCloseFacts, TabCloseStep, tab_close_step};

/// How many ids of a closed child's tab its record keeps (`MAX_CLOSED_TAB_IDS`).
const MAX_CLOSED_TAB_IDS: usize = 9;

fn close_facts(tab: &ControlTab) -> TabCloseFacts {
    TabCloseFacts {
        web_edits: tab.web_edits.map(|edits| edits.to_rules()),
        looked: tab.looked,
        user_touched: tab.user_touched,
    }
}

/// A quiet one-line note from `from` to a session (`id` makes a repeat a no-op): what `autoClose` leaves behind.
fn note_details(id: &str, from: &ControlTab, from_title: &str, text: &str) -> Value {
    json!({
        "id": id,
        "from": from.tab_id,
        "fromTitle": from_title,
        "kind": "note",
        "label": "note",
        "text": text,
    })
}

impl AgentControl {
    /// `#tabRow`: a tab's saved session as a stored row, read on the computer the tab runs on.
    pub(crate) fn tab_row(&self, tab: &ControlTab, path: &str) -> StoredSession {
        StoredSession {
            id: tab.tab_id.clone(),
            path: path.to_owned(),
            title: tab.title.clone(),
            cwd: tab.cwd.clone(),
            hidden: tab.hidden,
            tab_id: Some(tab.tab_id.clone()),
            device: tab.device.clone(),
            device_name: tab.device_name.clone(),
            ..StoredSession::default()
        }
    }

    /// `#transcript`: a child's newest messages: the saved file of one not started (on the computer it runs on),
    /// else its live omp.
    pub(crate) async fn transcript(&self, tab: &ControlTab, asleep: bool) -> Vec<AgentMessage> {
        if asleep {
            let Some(path) = tab.session_path.as_deref().filter(|path| !path.is_empty()) else {
                return Vec::new();
            };
            return self
                .host
                .stored_messages(&self.tab_row(tab, path))
                .await
                .unwrap_or_default();
        }
        self.host
            .command(
                &tab.tab_id,
                &json!({ "type": "get_transcript_page", "fromEnd": true, "limit": EVIDENCE_MESSAGES }),
                Deadline::Ms(self.tuning.state_timeout_ms),
            )
            .await
            .ok()
            .filter(|response| response.success)
            .and_then(|response| response.data)
            .and_then(|data| transcript_page(&data))
            .map(|page| page.messages)
            .unwrap_or_default()
    }

    /// `autoClose`: close the sessions `caller_tab_id` opened whose work has landed and that nobody is using
    /// (`auto_close_decision`): the tab closes the way the person's close does (the window refuses it for a tab in
    /// use), the session file stays (a throwaway child's is deleted) and the opener's family keeps a row for it; the
    /// worktree goes only when its branch is merged and it is clean. Called on tab activity and on a timer by
    /// `AgentControlRuntime`; one pass per caller at a time.
    pub async fn auto_close(&self, caller_tab_id: &str) -> R<()> {
        let (tabs, caller) = {
            let state = self.host.state();
            if !state.enabled || self.mem().sweeping.contains(caller_tab_id) {
                return Ok(());
            }
            let tabs = state.tabs(caller_tab_id);
            let caller = tabs
                .as_ref()
                .and_then(|tabs| tabs.iter().find(|tab| tab.tab_id == caller_tab_id).cloned());
            (tabs, caller)
        };
        let (Some(tabs), Some(caller)) = (tabs, caller) else {
            return Ok(());
        };
        if caller.session_path.as_deref().is_none_or(str::is_empty) {
            return Ok(());
        }
        self.mem().sweeping.insert(caller_tab_id.to_owned());
        let swept = self.auto_close_pass(&caller, &tabs).await;
        self.mem().sweeping.remove(caller_tab_id);
        swept
    }

    async fn auto_close_pass(&self, caller: &ControlTab, tabs: &[ControlTab]) -> R<()> {
        let opener_idle = !caller.busy && !caller.resuming && !waits(caller);
        for tab in tabs {
            {
                let state = self.host.state();
                if !self
                    .opened_by(&state, &caller.tab_id, tabs)
                    .contains(&tab.tab_id)
                    || self.mem().closing.contains(&tab.tab_id)
                {
                    continue;
                }
            }
            if tab.busy || waits(tab) {
                let mut mem = self.mem();
                mem.collected.remove(&tab.tab_id);
                if tab.busy
                    && let Some(asked) = mem.nudged.get_mut(&tab.tab_id)
                {
                    asked.ran = true;
                }
                continue;
            }
            if !tab.auto_closable || tab.hidden {
                continue;
            }
            // A child restored after a relaunch is judged by its transcript: not started (asleep), or started and
            // not run yet this launch (no lastRun). One this launch opened waits for its first turn to end.
            if tab.status != TabStatus::Ready && !(tab.restored && tab.status == TabStatus::Asleep)
            {
                continue;
            }
            if tab.last_run.is_none() && !tab.restored {
                continue;
            }
            let facts = self.auto_close_facts(tab, opener_idle).await;
            let reported = self.auto_done(caller, tabs, tab, &facts).await?;
            // A problem child's tab holds the only live trace of its failure, and a throwaway child's session goes
            // with its tab: the report just sent is read in the opener's next turn, so the tab closes in a later
            // pass (the opener idle again, or a read of it).
            if reported && (facts.result == Verdict::Problem || facts.throwaway) {
                continue;
            }
            // A question or blocker the opener has not answered is the child waiting: it stays open for the answer.
            if facts.result == Verdict::Problem
                && self
                    .mailbox
                    .state(&tab.tab_id, &caller.tab_id)
                    .is_some_and(|state| state.waiting)
            {
                continue;
            }
            match auto_close_decision(&facts) {
                AutoCloseDecision::Close {
                    remove_worktree,
                    delete_session,
                } => {
                    self.auto_close_tab(caller, tab, remove_worktree, delete_session)
                        .await?;
                }
                AutoCloseDecision::Keep(_) => self.nudge_silent(caller, tab, &facts).await?,
            }
        }
        Ok(())
    }

    /// `#autoDone`: a child whose turn ended well with a verdict line (`Result: ok` / `Result: problem — <reason>`)
    /// and sent its opener nothing on the current dispatch gets its `done` report sent for it: the final answer,
    /// through `report` (custody line, outbox, dedupe id, delivery). Measured: the child's own `ompdesk_report` done
    /// cost every worker dispatch two extra model requests. Never a failed or stopped turn, one the person typed
    /// into, or a dispatch that already has a report. A child a relaunch restored counts once a turn of this launch
    /// ended (it went on with its cut-off work, or took a message after the relaunch): its journal says whether it
    /// reported that work itself, and a report main sent before the relaunch has the same id, which the opener's
    /// journal drops. Resolves true when it sent the report.
    async fn auto_done(
        &self,
        caller: &ControlTab,
        tabs: &[ControlTab],
        tab: &ControlTab,
        facts: &AutoCloseFacts,
    ) -> R<bool> {
        if !facts.opened_by_agent
            || !facts.idle
            || !facts.settled
            || !facts.answered
            || facts.ended != Ended::Ok
            || !matches!(facts.result, Verdict::Ok | Verdict::Problem)
            || facts.user_touched
            || (tab.restored && tab.last_run.is_none())
            || self.host.state().parent_of(&tab.tab_id) != Some(caller.tab_id.as_str())
        {
            return Ok(false);
        }
        if tab.restored {
            if !self.mailbox.knows(&tab.tab_id) {
                let marks = self.journal_marks(&tab.tab_id).await;
                self.mailbox.seed(&tab.tab_id, marks.dispatch);
            }
            if transcript_ending(&self.transcript(tab, false).await).reported_done {
                return Ok(false);
            }
        }
        let dispatch = self.mailbox.current(&tab.tab_id);
        let state = self.mailbox.state(&tab.tab_id, &caller.tab_id);
        // A question or blocker the opener has not answered stays the child's standing word: a done would read as
        // settled.
        if state.as_ref().is_some_and(|state| state.waiting) {
            return Ok(false);
        }
        // Only a finishing report of this dispatch stands for the answer: a milestone's progress or a note leaves
        // the finish to tell.
        if let Some(state) = &state
            && state.last.dispatch == dispatch
            && matches!(state.last.kind, MailKind::Done | MailKind::Review)
        {
            return Ok(false);
        }
        let dispatch_key = dispatch.clone().unwrap_or_default();
        if self.mem().auto_done_for.get(&tab.tab_id) == Some(&dispatch_key) {
            return Ok(false);
        }
        let session = self.session_state(tab).await;
        let answer = trim(session.last.as_deref().unwrap_or("")).to_owned();
        if parse_worker_result(Some(&answer)).is_none() {
            return Ok(false);
        }
        self.mem()
            .auto_done_for
            .insert(tab.tab_id.clone(), dispatch_key);
        let sent = self
            .report(
                tab,
                tabs,
                ReportArgs {
                    kind: "done".to_owned(),
                    text: cut(&answer, MESSAGE_MAX_CHARS),
                    dispatch,
                    ..ReportArgs::default()
                },
            )
            .await;
        Ok(sent.is_ok())
    }

    /// `#nudgeSilent`: a child whose turn ended well but said nothing about its work (no verdict line, no report on
    /// its current dispatch) is asked once to report; if its next turn still says nothing, its opener is told once.
    /// Never a child the person typed into, one restored by a relaunch, a failed or stopped turn, or one still
    /// working. Idea after OpenRig's stuck sweep and its custody rule that a closed item names how it ended
    /// (mvschwarz/openrig, docs/as-built/architecture/coordination-primitive.md, Apache-2.0).
    async fn nudge_silent(
        &self,
        caller: &ControlTab,
        tab: &ControlTab,
        facts: &AutoCloseFacts,
    ) -> R<()> {
        if !facts.opened_by_agent
            || !facts.idle
            || !facts.settled
            || !facts.answered
            || facts.ended != Ended::Ok
            || facts.result != Verdict::Missing
            || facts.user_touched
            || tab.restored
        {
            return Ok(());
        }
        let dispatch = self.mailbox.current(&tab.tab_id);
        if let Some(report) = self.mailbox.state(&tab.tab_id, &caller.tab_id)
            && report.last.dispatch == dispatch
        {
            return Ok(());
        }
        let answer = self.session_state(tab).await.last.unwrap_or_default();
        let asked = self.mem().nudged.get(&tab.tab_id).cloned();
        let quiet = |text: &str| {
            note_details(
                &format!(
                    "nudge:{}:{}:{}",
                    tab.session_path.as_deref().unwrap_or(&tab.tab_id),
                    dispatch.as_deref().unwrap_or(""),
                    super::super::js::len16(text)
                ),
                caller,
                &caller.title,
                text,
            )
        };
        match asked {
            Some(asked) if asked.dispatch == dispatch => {
                // Still nothing after the turn it was asked in (seen running since, or a new answer is in): its
                // opener hears of it, once.
                if asked.told_opener || (!asked.ran && answer == asked.answer) {
                    return Ok(());
                }
                if let Some(nudge) = self.mem().nudged.get_mut(&tab.tab_id) {
                    nudge.told_opener = true;
                }
                let text = format!(
                    "{} ended its turn again without a verdict line or a report, after OMPdesk asked it to report. Read its answer (ompdesk_session_result) or ask it where the work stands.",
                    label(tab)
                );
                let _ = self
                    .host
                    .mail(
                        &caller.tab_id,
                        &text,
                        &quiet(&text),
                        delivery_for(MailKind::Note),
                    )
                    .await;
            }
            _ => {
                self.mem().nudged.insert(
                    tab.tab_id.clone(),
                    Nudge {
                        dispatch: dispatch.clone(),
                        answer,
                        ran: false,
                        told_opener: false,
                    },
                );
                let text = format!(
                    "OMPdesk: your turn ended with no `Result: ok` / `Result: problem — <reason>` line and no ompdesk_report about this work. Report where it stands now with ompdesk_report (kind done, blocked or question{}), and end your final answer with the Result line.",
                    match &dispatch {
                        Some(dispatch) if !dispatch.is_empty() =>
                            format!(", dispatch \"{dispatch}\""),
                        _ => String::new(),
                    }
                );
                let _ = self
                    .host
                    .mail(
                        &tab.tab_id,
                        &text,
                        &quiet(&text),
                        MailDelivery {
                            trigger_turn: true,
                            aside: true,
                        },
                    )
                    .await;
            }
        }
        Ok(())
    }

    /// `#autoCloseFacts`.
    async fn auto_close_facts(&self, tab: &ControlTab, opener_idle: bool) -> AutoCloseFacts {
        let asleep = tab.status == TabStatus::Asleep;
        let session = if asleep {
            None
        } else {
            Some(self.session_state(tab).await)
        };
        let session_last = session.as_ref().and_then(|session| session.last.as_deref());
        // The transcript speaks where this launch saw nothing (restored, asleep) and for an answer without a
        // verdict line, whose final `done` report may stand for it.
        let ending: Option<TranscriptEnding> =
            if asleep || tab.restored || parse_worker_result(session_last).is_none() {
                Some(transcript_ending(&self.transcript(tab, asleep).await))
            } else {
                None
            };
        let last: Option<&str> = session_last.or(ending.as_ref().and_then(|e| e.last.as_deref()));
        let branch = match &tab.worktree {
            Some(worktree) => Some(
                match self
                    .host
                    .landing(&worktree.reference(), tab.device.as_deref())
                    .await
                {
                    Ok(landing) => BranchLanding {
                        has_work: landing.has_work,
                        landed: landing.landed,
                        clean: landing.clean,
                    },
                    Err(_) => BranchLanding {
                        has_work: false,
                        landed: false,
                        clean: false,
                    },
                },
            ),
            None => None,
        };
        let stop_reason = tab
            .last_run
            .as_ref()
            .map(|run| run.stop_reason.as_str())
            .or(ending.as_ref().and_then(|e| e.stop_reason.as_deref()));
        let state: Option<&SessionStateInfo> = session.as_ref().and_then(|s| s.state.as_ref());
        let throwaway = self.mem().throwaway.contains(&tab.tab_id);
        let collected = opener_idle || self.mem().collected.contains(&tab.tab_id);
        AutoCloseFacts {
            opened_by_agent: tab.auto_closable,
            stored: tab.session_path.is_some(),
            idle: asleep || state.is_some_and(|state| !state.is_streaming),
            settled: asleep || state.and_then(|state| state.is_settled) != Some(false),
            answered: !trim(last.unwrap_or("")).is_empty(),
            ended: if matches!(stop_reason, Some("error" | "aborted")) {
                Ended::Failed
            } else {
                Ended::Ok
            },
            result: match parse_worker_result(last) {
                Some(WorkerResult::Ok) => Verdict::Ok,
                Some(WorkerResult::Problem { .. }) => Verdict::Problem,
                None if ending.as_ref().is_some_and(|e| e.reported_done) => Verdict::Ok,
                None => Verdict::Missing,
            },
            branch,
            looked: tab.looked,
            user_touched: tab.user_touched
                || (tab.restored && ending.as_ref().is_some_and(|e| e.person_prompted)),
            collected,
            throwaway,
        }
    }

    /// `#deleteThrowaway`: a throwaway child's saved session goes with its tab, on the computer it is saved on (the
    /// sidebar's delete), and its opener gets one quiet line saying so. Not when a tab holds the session again (the
    /// person reopened it meanwhile) or the delete failed: then it stays like any closed child. Resolves true when
    /// it was deleted.
    pub(crate) async fn delete_throwaway(
        &self,
        caller: &ControlTab,
        tab: &ControlTab,
        path: &str,
    ) -> bool {
        let held = self.host.state().tabs(&caller.tab_id).is_some_and(|open| {
            open.iter()
                .any(|open| open.session_path.as_deref() == Some(path) && open.device == tab.device)
        });
        if held {
            return false;
        }
        if self
            .host
            .delete_stored(&self.tab_row(tab, path))
            .await
            .is_err()
        {
            return false;
        }
        self.fates().deleted(
            self.fated(tab, caller.session_path.as_deref()),
            fate_by::THROWAWAY,
            None,
        );
        let text = format!(
            "Deleted {}: it was opened as throwaway and its answer reached you.",
            label(tab)
        );
        let id = format!("throwaway:{}:{path}", tab.device.as_deref().unwrap_or(""));
        let _ = self
            .host
            .mail(
                &caller.tab_id,
                &text,
                &json!({
                    "id": id,
                    "from": tab.tab_id,
                    "fromTitle": tab.title,
                    "kind": "note",
                    "label": "note",
                    "text": text,
                }),
                delivery_for(MailKind::Note),
            )
            .await;
        true
    }

    /// `#autoCloseTab`.
    async fn auto_close_tab(
        &self,
        caller: &ControlTab,
        tab: &ControlTab,
        remove_worktree: bool,
        delete_session: bool,
    ) -> R<()> {
        // A tab the close would keep (its paired page's unsaved Files edits): not worth reading the child.
        if matches!(
            tab_close_step(&close_facts(tab), false),
            TabCloseStep::Keep(_)
        ) {
            return Ok(());
        }
        self.mem().closing.insert(tab.tab_id.clone());
        let done = self
            .auto_close_tab_closing(caller, tab, remove_worktree, delete_session)
            .await;
        self.mem().closing.remove(&tab.tab_id);
        done
    }

    async fn auto_close_tab_closing(
        &self,
        caller: &ControlTab,
        tab: &ControlTab,
        remove_worktree: bool,
        delete_session: bool,
    ) -> R<()> {
        // Read before the close: the closed record keeps them for the opener's family cost.
        let (model, cost, split) = tokio::join!(
            async {
                let response = self
                    .host
                    .command(
                        &tab.tab_id,
                        &json!({ "type": "get_state", "brief": true }),
                        Deadline::Ms(self.tuning.state_timeout_ms),
                    )
                    .await
                    .ok()
                    .filter(|response| response.success)?;
                let info: SessionStateInfo = serde_json::from_value(response.data?).ok()?;
                info.model
            },
            self.cost(tab),
            self.split(tab),
        );
        // Not closed (the window kept it, the person came to it meanwhile, or its paired page holds unsaved Files
        // edits in it): nothing else changes, and a later pass tries again.
        let outcome = self
            .close_tab(
                &caller.tab_id,
                &tab.tab_id,
                CloseHow {
                    auto: true,
                    wait_ms: self.tuning.auto_close_wait_ms,
                    cleared: false,
                },
            )
            .await?;
        if outcome != TabClose::Closed {
            return Ok(());
        }
        self.mem().throwaway.remove(&tab.tab_id);
        let removed = match (&tab.worktree, remove_worktree) {
            (Some(worktree), true) => matches!(
                self.host
                    .remove_safe_worktree(&worktree.reference(), tab.device.as_deref())
                    .await,
                Ok(Some(_))
            ),
            _ => false,
        };
        let path = tab.session_path.clone().unwrap_or_default();
        // A worktree git kept would lose the session that names it: then the session stays too.
        if delete_session
            && (tab.worktree.is_none() || removed)
            && self.delete_throwaway(caller, tab, &path).await
        {
            return Ok(());
        }
        self.remember_closed(tab, Some(caller), fate_by::AUTO_CLOSE);
        let mut tab_ids = vec![tab.tab_id.clone()];
        tab_ids.extend(tab.former_ids.iter().cloned());
        tab_ids.truncate(MAX_CLOSED_TAB_IDS);
        self.host.record_closed(&ClosedChild {
            path,
            opened_by_session: caller.session_path.clone().unwrap_or_default(),
            title: tab.name().to_owned(),
            cwd: match (&tab.worktree, removed) {
                (Some(worktree), true) => worktree.base_cwd.clone(),
                _ => tab.cwd.clone(),
            },
            device: tab.device.clone(),
            // The ids its opener was given keep naming the session after a relaunch (`find`).
            tab_ids: Some(tab_ids),
            closed_at: self.now(),
            model: model.map(|model| format!("{}/{}", model.provider, model.id)),
            cost: (cost > 0.0).then_some(cost),
            split,
        });
        Ok(())
    }
}
