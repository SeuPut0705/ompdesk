//! What a session is doing right now and how a line says it (`service.ts`: `#state`, `#stateLine`, `#withPickup`).

use serde_json::{Value, json};

use super::AgentControl;
use super::host::{Deadline, HostState};
use super::js::one_line;
use super::text::{ask_title, current_step, elapsed_text, transcript_page};
use super::types::{ControlTab, SessionStateInfo, TabStatus, running_agent_count};
use crate::agentctl::rules::pickup::{PickupFacts, PickupReport, pickup_of};

/// `SessionState`: a session as its omp says it now.
#[derive(Clone, Debug, Default)]
pub struct SessionState {
    pub state: Option<SessionStateInfo>,
    pub last: Option<String>,
    pub step: Option<String>,
    /// Its subagents that run now, from the summary every row reads.
    pub subagents: usize,
}

impl AgentControl {
    /// `#state`: `get_state`, the last assistant text and, while a turn runs, the tail of its transcript, each with
    /// `state_timeout_ms` and a failure read as nothing. A hidden session, or one whose omp is not up, says nothing.
    pub async fn session_state(&self, tab: &ControlTab) -> SessionState {
        if tab.hidden || !tab.status.is_up() {
            return SessionState::default();
        }
        let deadline = Deadline::Ms(self.tuning.state_timeout_ms);
        let call = |command: Value| async move {
            let response = self
                .host
                .command(&tab.tab_id, &command, deadline)
                .await
                .ok()?;
            if response.success {
                Some(response.data.unwrap_or(Value::Null))
            } else {
                None
            }
        };
        let (state, last, page) = tokio::join!(
            call(json!({ "type": "get_state", "brief": true })),
            call(json!({ "type": "get_last_assistant_text" })),
            async {
                if tab.busy {
                    call(json!({ "type": "get_transcript_page", "fromEnd": true, "limit": 8 }))
                        .await
                } else {
                    None
                }
            }
        );
        let state_info = state.and_then(|data| {
            if data.is_null() {
                None
            } else {
                serde_json::from_value(data).ok()
            }
        });
        let last =
            last.and_then(|data| data.get("text").and_then(Value::as_str).map(str::to_owned));
        let step = page
            .and_then(|data| transcript_page(&data))
            .and_then(|page| current_step(&page.messages));
        SessionState {
            state: state_info,
            last,
            step,
            subagents: running_agent_count(self.host.state().summary_of(tab)),
        }
    }

    /// `#stateLine`.
    pub fn state_line(
        &self,
        state: &HostState,
        tab: &ControlTab,
        session: &SessionState,
    ) -> String {
        let step = session.step.as_deref().filter(|step| !step.is_empty());
        if let Some(ask) = tab.asks.first() {
            return format!(
                "waiting for the user's answer: \"{}\"",
                one_line(&ask_title(&ask.request), 120)
            );
        }
        if let Some(plan) = &tab.plan {
            let title = if plan.title.is_empty() {
                "plan"
            } else {
                plan.title.as_str()
            };
            return format!(
                "waiting for plan approval: \"{}\" ({})",
                one_line(title, 120),
                plan.plan_file_path
            );
        }
        match tab.status {
            TabStatus::Asleep => {
                return "not started (it starts when shown or messaged)".to_owned();
            }
            TabStatus::Starting | TabStatus::Restarting | TabStatus::Waiting => {
                let link = tab.device.as_deref().and_then(|id| state.device(id));
                if let Some(link) = link
                    && link.state != super::types::DeviceState::Online
                {
                    return format!(
                        "starting: {} is {} (its link is down; this session goes on once it is back)",
                        link.name,
                        link.state.as_str()
                    );
                }
                return match tab.start_wait {
                    Some(super::types::StartWait::Queued) => {
                        "starting (waits its turn behind other sessions starting; nothing to do)".to_owned()
                    }
                    Some(super::types::StartWait::Slow) => {
                        "starting (its omp has not answered yet and is still waited for; nothing was stopped)".to_owned()
                    }
                    None => "starting".to_owned(),
                };
            }
            TabStatus::Error | TabStatus::Exited => {
                if tab.session_held {
                    return "waiting for another omp process to let go of this session (it opens here by itself then; nothing to do)".to_owned();
                }
                return format!("stopped ({})", tab.status.as_str());
            }
            TabStatus::Ready | TabStatus::Running => {}
        }
        let streaming = session
            .state
            .as_ref()
            .is_some_and(|state| state.is_streaming);
        if tab.busy || streaming {
            let since = tab
                .busy_since
                .filter(|since| *since != 0.0)
                .map_or_else(String::new, |since| {
                    format!(", for {}", elapsed_text(self.now() - since))
                });
            return format!(
                "running{}{since}",
                step.map_or_else(String::new, |step| format!(", {step}"))
            );
        }
        if session
            .state
            .as_ref()
            .is_some_and(|state| state.is_settled == Some(false))
        {
            return "running (background work still going)".to_owned();
        }
        "idle".to_owned()
    }

    /// `#withPickup`: an idle session the caller opened says where it left the work (`pickup.rs`); every other line is
    /// as it is.
    pub fn with_pickup(
        &self,
        state: &HostState,
        caller: &ControlTab,
        tab: &ControlTab,
        session: &SessionState,
        line: &str,
    ) -> String {
        if line != "idle" || state.parent_of(&tab.tab_id) != Some(caller.tab_id.as_str()) {
            return line.to_owned();
        }
        let report = self
            .mailbox
            .state(&tab.tab_id, &caller.tab_id)
            .map(|state| state.last);
        let facts = PickupFacts {
            answer: session.last.clone(),
            report: report.map(|mail| PickupReport {
                kind: mail.kind,
                dispatch: mail.dispatch.filter(|dispatch| !dispatch.is_empty()),
            }),
            dispatch: self.mailbox.current(&tab.tab_id),
        };
        match pickup_of(&facts) {
            Some(pickup) => format!("idle, {pickup}"),
            None => line.to_owned(),
        }
    }
}
