//! Every wait of the service, in milliseconds, with the TypeScript's values as defaults (`service.ts`' constants and
//! the literals beside them). A test shortens them through the `tuning` field of the open request (the TypeScript
//! tests used fake timers). A family that finds one more literal adds a field here with its default.

use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tuning {
    /// How long one open waits, all its commands together, for a child that answered `sidecar_not_ready`.
    pub open_ready_retry_ms: u64,
    /// After such an answer an open looks at the tab again no sooner than this.
    pub open_ready_pause_ms: u64,
    /// A wait re-reads the session at least this often even when no tab event arrives.
    pub poll_ms: u64,
    /// What `get_state`, `get_last_assistant_text` and the like are given.
    pub state_timeout_ms: u64,
    /// What a command `ompdesk_app` sends to another computer's omp gets when it names no window of its own.
    pub rpc_on_timeout_ms: u64,
    /// How long a tool call waits for an untitled tab's saved name.
    pub name_lookup_ms: u64,
    /// An automatic close waits this long for the window to drop the tab.
    pub auto_close_wait_ms: u64,
    /// A sent message's receipt waits this long to see the target's turn start.
    pub turn_start_wait_ms: u64,
    /// A paired device's link is waited for this long while it is not online.
    pub link_wait_ms: u64,
    /// How long a send waits for the person to send or clear a draft they are typing into its target.
    pub draft_wait_ms: u64,
    /// Back on the link, a device's tab re-attaches within this.
    pub reattach_wait_ms: u64,
    /// A device or tab that is not there yet is looked at again this often.
    pub link_poll_ms: u64,
    /// A close or delete gives stock's abort this long and goes on.
    pub abort_before_close_ms: u64,
    /// A plain stop waits this long for stock's abort to confirm; a delete, which needs the turn over, as long.
    pub stop_wait_ms: u64,
    /// The caller's omp says who started its run within this.
    pub person_turn_wait_ms: u64,
    /// A close is confirmed by the window dropping the tab within this.
    pub close_wait_ms: u64,
    /// After the tab is gone, its omp gets this long to exit before the close is reported anyway.
    pub omp_exit_wait_ms: u64,
    /// A started tab is looked at again this often while it is waited for (`#whenReady`).
    pub ready_poll_ms: u64,
    /// `ompdesk_session_result` re-reads a wait at least this often (a literal 1000 in the TypeScript).
    pub result_poll_ms: u64,
    /// `clearQueue`'s command.
    pub clear_queue_ms: u64,
    /// A prompt handed to a session (a send, a redelivery).
    pub prompt_ms: u64,
    /// The judge's request.
    pub judge_ms: u64,
    /// How long a tab that is going is waited for (`#whenGone`).
    pub when_gone_ms: u64,
    /// The mailbox coalesces progress reports for this long.
    pub mail_coalesce_ms: u64,
    /// A command of an open whose child reads `error` is given this long more to be answered (a refusal that says it
    /// is not ready arrives just after the status that caused it).
    pub answer_grace_ms: u64,
}

impl Default for Tuning {
    fn default() -> Tuning {
        Tuning {
            open_ready_retry_ms: 30_000,
            open_ready_pause_ms: 250,
            poll_ms: 3_000,
            state_timeout_ms: 5_000,
            rpc_on_timeout_ms: 30_000,
            name_lookup_ms: 2_000,
            auto_close_wait_ms: 2_000,
            turn_start_wait_ms: 1_500,
            link_wait_ms: 15_000,
            draft_wait_ms: 60_000,
            reattach_wait_ms: 10_000,
            link_poll_ms: 250,
            abort_before_close_ms: 3_000,
            stop_wait_ms: 30_000,
            person_turn_wait_ms: 5_000,
            close_wait_ms: 5_000,
            omp_exit_wait_ms: 5_000,
            ready_poll_ms: 500,
            result_poll_ms: 1_000,
            clear_queue_ms: 15_000,
            prompt_ms: 30_000,
            judge_ms: 180_000,
            when_gone_ms: 10_000,
            mail_coalesce_ms: crate::agentctl::rules::mail::MAIL_COALESCE_MS,
            answer_grace_ms: 500,
        }
    }
}
