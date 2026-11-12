//! Family 3, work: judging, merging, scheduling, Autopilot, the review board, auto-close and the app tools.
//!
//! Owns these TypeScript methods: `#compare` (4025), `#evidence` (3936), `#judge` (4050), `#merge` (4111),
//! `#mergeable` (4134), `#runMerge` (4142), `#reviewItem` (4171), `reviewItems`, `review`, `familyEdits`,
//! `#closedEdits`, `liveReview` (4233-4420), `autoClose` (4496), `#autoDone` (4544), `#nudgeSilent` (4592),
//! `#autoCloseFacts` (4633), `#tabRow`, `#transcript` (4666-4695), `#autoCloseTab` (4748), `#deleteThrowaway`
//! (4720), `#schedule` (4802), `#frequencyOf` (4914), `#autopilot`, `#runStatus`, `#autopilotStart`,
//! `#autopilotFrom` (4962-5105), `#rpcOn` (3779), `#utilityTab`, `#closeUtilityTabs`, `#discardUtility`
//! (3806-3849), `#appControl`, `#appAutopilot` and the `ompdesk_app` arm of `#dispatch` with `#appRuns`
//! (1750-1762, 1710-1726). `released` calls `app_released`, the hook for `AppControl.released`.
//!
//! The `AppControl` (`agentctl::app`, generic over `AppPorts`) is built here: an `AppPorts` over this service's
//! `Host` (`app_get_pref`, `app_set_pref`, `app_rpc`, `app_invoke`, `app_note`, `app_open_privacy_pane`,
//! `app_fire`, `app_send`, `HostState::app` and the lookups the port's `device` and `callerTitle` become), whose
//! `autopilot` is `app_autopilot` and `rpc_on` is `rpc_on` below.
//!
//! Already shared: `schedule_source` (`ScheduleSource`), `find`, `open`, `device`, `reach`, `opened_by`,
//! `refuse_in_use`, `session_state`, the pure functions of `text` (`start_options`, `describe_run`, `bound_diff`,
//! `merge_problem`, `parse_verdict`, `checks_run`, `transcript_ending`, ...).

use serde_json::Value;

use super::AgentControl;
use super::fail::{Fail, R};
use super::types::{AppArgs, AppListArgs, AutopilotArgs, ControlTab, ScheduleArgs};

impl AgentControl {
    /// `ompdesk_compare` (`#compare`).
    pub(super) async fn compare(
        &self,
        _caller: &ControlTab,
        _tabs: &[ControlTab],
        _sessions: Option<Vec<String>>,
        _criteria: Option<Vec<String>>,
    ) -> R<String> {
        Err(Fail::not_ported("ompdesk_compare"))
    }

    /// `ompdesk_merge` of `target`, resolved by `open` (`#merge`).
    pub(super) async fn merge(&self, _caller: &ControlTab, _target: &ControlTab) -> R<String> {
        Err(Fail::not_ported("ompdesk_merge"))
    }

    /// `ompdesk_schedule` (`#schedule`).
    pub(super) async fn schedule(&self, _caller: &ControlTab, _args: ScheduleArgs) -> R<String> {
        Err(Fail::not_ported("ompdesk_schedule"))
    }

    /// `ompdesk_autopilot` (`#autopilot`).
    pub(super) async fn autopilot(
        &self,
        _caller: &ControlTab,
        _tabs: &[ControlTab],
        _args: AutopilotArgs,
    ) -> R<String> {
        Err(Fail::not_ported("ompdesk_autopilot"))
    }

    /// `ompdesk_app_list`.
    pub(super) async fn app_list(&self, _args: AppListArgs) -> R<String> {
        Err(Fail::not_ported("ompdesk_app_list"))
    }

    /// `ompdesk_app`: the `T.app` arm of `#dispatch`, with its running-action count and `#closeUtilityTabs`.
    pub(super) async fn app(&self, _caller: &ControlTab, _args: AppArgs) -> R<String> {
        Err(Fail::not_ported("ompdesk_app"))
    }

    /// `this.#app?.released(tabId)`: the hook `released` calls; empty until the work family builds the `AppControl`.
    pub(super) fn app_released(&self, _tab_id: &str) {}

    /// `reviewItems`: the sessions `caller_tab_id` opened that wait for the person (or still run).
    pub async fn review_items(&self, _caller_tab_id: &str) -> R<Value> {
        Err(Fail::not_ported("reviewItems"))
    }

    /// `review`: the work board's list plus what every session the caller opened runs on and has cost.
    pub async fn review(&self, _caller_tab_id: &str) -> R<Value> {
        Err(Fail::not_ported("review"))
    }

    /// `familyEdits`: what each session the caller opened changed.
    pub async fn family_edits(&self, _caller_tab_id: &str, _since: Option<f64>) -> R<Value> {
        Err(Fail::not_ported("familyEdits"))
    }

    /// `liveReview`: `last` with what moves inside a running child's turn read again; None when none runs.
    pub async fn live_review(
        &self,
        _caller_tab_id: &str,
        _last: Value,
        _only: Option<Vec<String>>,
    ) -> R<Option<Value>> {
        Err(Fail::not_ported("liveReview"))
    }

    /// `autoClose`: one pass over the sessions the caller opened whose work landed.
    pub async fn auto_close(&self, _caller_tab_id: &str) -> R<()> {
        Err(Fail::not_ported("autoClose"))
    }
}
