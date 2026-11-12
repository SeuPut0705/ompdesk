//! Family 2, messages: what sessions say to each other.
//!
//! Owns these TypeScript methods: `#send` (2574), `#untilDraftSent` (2606), `#deliverSend` (2623), `#handSend`
//! (2649), `#owedDeps` and `redeliverSends` (2765-2798), `#journalMarks` (2800), `#turnStarts` (2809),
//! `#reportFields` (2824), `#report` (2839), `#queuedNote` (2935), `#answer` (3363), `#answerPlan` (3474), the mail
//! side of `childAsked` (1387) and `personTyped` (3739), and the receipts, in-flight sends and `#cardsTold` /
//! `#reportedAt` / `#queuedFollowUp` / `#nudged` state in `Mem`. `#mailbox` is `self.mailbox`, the send outbox
//! `self.send_outbox` (`journal::send_outbox::deliver_owed`, `redeliver_sends`, `OwedDeps`).
//!
//! `redeliverSends(tabOf)` takes no function over the wire: `tabOf(path, device)` is the tab of `HostState::tabs`
//! holding that session on that computer (a tab main runs for a device is in no list of `tabs`, as with `hosted`),
//! started with `host.start` when it reads `asleep`, and the receiver only when it is `ready`.
//!
//! Already shared: `find`, `open`, `send_target`, `own_closed`, `session_state`, `refuse_hidden`, `mailbox`.

use super::AgentControl;
use super::fail::{Fail, R};
use super::types::{AnswerArgs, ControlTab, ReportArgs, SendArgs};

impl AgentControl {
    /// `ompdesk_session_send` to `target`, resolved by `send_target` (`#send`).
    pub(super) async fn send(
        &self,
        _caller: &ControlTab,
        _target: &ControlTab,
        _args: &SendArgs,
    ) -> R<String> {
        Err(Fail::not_ported("ompdesk_session_send"))
    }

    /// `ompdesk_report` (`#report`).
    pub(super) async fn report(
        &self,
        _caller: &ControlTab,
        _tabs: &[ControlTab],
        _args: ReportArgs,
    ) -> R<String> {
        Err(Fail::not_ported("ompdesk_report"))
    }

    /// `ompdesk_session_answer` (`#answer`, `#answerPlan`).
    pub(super) async fn answer(
        &self,
        _caller: &ControlTab,
        _target: &ControlTab,
        _args: &AnswerArgs,
    ) -> R<String> {
        Err(Fail::not_ported("ompdesk_session_answer"))
    }

    /// `childAsked`: a child showed a question card; its opener hears of it as one question.
    pub async fn child_asked(
        &self,
        _opener_tab_id: &str,
        _child_tab_id: &str,
        _request_id: &str,
    ) -> R<()> {
        Err(Fail::not_ported("childAsked"))
    }

    /// `personTyped`: the person typed a prompt to `tabId`: the cleanups its agent was refused are listed to it once.
    pub fn person_typed(&self, _tab_id: &str) {}

    /// `redeliverSends`: one pass over every session still owed a message.
    pub async fn redeliver_sends(&self) -> R<()> {
        Err(Fail::not_ported("redeliverSends"))
    }
}
