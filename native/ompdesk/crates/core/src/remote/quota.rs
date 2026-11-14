//! One daily model quota for desktop peers and web devices. Stores provide an atomic mutation of the existing
//! device record, so a check and its reservation never race with another caller or a limit change.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::schedules::rules::{Local, Zone};
use crate::server::Fault;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requests_per_day: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_per_day: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub day: String,
    pub requests: f64,
    pub tokens: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct QuotaRecord {
    pub limits: Option<Limits>,
    pub usage: Option<Usage>,
}

/// The implementation holds its device store's lock through the closure and the existing kept-save path.
/// `change` runs exactly once when the record exists. Its result says whether to persist the quota fields;
/// the method's result says whether the device exists. Other record fields are never replaced.
pub trait QuotaStore: Send + Sync {
    fn update(&self, device_id: &str, change: &mut dyn FnMut(&mut QuotaRecord) -> bool) -> Result<bool, Fault>;
}

/// The existing desktop peer store. Web's FileDevices implements the same interface over its Book lock.
pub struct PeerStore(pub Arc<Mutex<super::store::Store>>);

impl QuotaStore for PeerStore {
    fn update(&self, device_id: &str, change: &mut dyn FnMut(&mut QuotaRecord) -> bool) -> Result<bool, Fault> {
        let mut store = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let Some(peer) = store.get(device_id) else { return Ok(false); };
        let mut record = QuotaRecord {
            limits: peer.get("limits").and_then(|v| serde_json::from_value(v.clone()).ok()),
            usage: peer.get("usage").and_then(|v| serde_json::from_value(v.clone()).ok()),
        };
        if change(&mut record) {
            let limits = record.limits.map(|limits| json!(limits));
            let usage = record.usage.map(|usage| json!(usage));
            store.update(device_id, vec![("limits".into(), limits), ("usage".into(), usage)])
                .map_err(|error| Fault::new("quota_save", error.to_string()))?;
        }
        Ok(true)
    }
}

#[derive(Clone)]
pub struct PeerQuota {
    store: Arc<dyn QuotaStore>,
    day: Arc<dyn Fn() -> String + Send + Sync>,
}

fn local_day() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |time| time.as_millis().min(i64::MAX as u128) as i64);
    let day = Local.day(ms);
    format!("{:04}-{:02}-{:02}", day.year, day.month, day.day)
}

fn today(record: &QuotaRecord, day: &str) -> Usage {
    record.usage.as_ref().filter(|usage| usage.day == day).cloned()
        .unwrap_or_else(|| Usage { day: day.to_owned(), requests: 0.0, tokens: 0.0 })
}

fn count(value: f64) -> Result<(), Fault> {
    if value.is_finite() && value >= 0.0 { Ok(()) }
    else { Err(Fault::new("invalid_params", "A quota count must be finite and nonnegative")) }
}

impl PeerQuota {
    pub fn new(store: Arc<dyn QuotaStore>) -> Self {
        Self { store, day: Arc::new(local_day) }
    }

    pub fn usage(&self, device_id: &str) -> Result<Usage, Fault> {
        let day = (self.day)();
        let mut used = Usage { day: day.clone(), ..Usage::default() };
        self.store.update(device_id, &mut |record| { used = today(record, &day); false })?;
        Ok(used)
    }

    /// A consuming refund receipt. Dropping a successful reservation commits its count, as the TS caller did.
    /// Delivery-id deduplication belongs before this call; a replay is not a second reservation.
    pub fn reserve(&self, device_id: &str, requests: f64) -> Result<Reservation, Fault> {
        count(requests)?;
        let day = (self.day)();
        let mut refusal = None;
        let exists = self.store.update(device_id, &mut |record| {
            let mut used = today(record, &day);
            if let Some(limits) = &record.limits {
                if limits.requests_per_day.is_some_and(|limit| used.requests + requests > limit) {
                    refusal = Some(if requests > 1.0 {
                        format!("This needs {requests} of this device's daily requests on this computer's models, more than are left today.")
                    } else { "This device's request limit for today on this computer's models is used up.".into() });
                    return false;
                }
                if limits.tokens_per_day.is_some_and(|limit| used.tokens >= limit) {
                    refusal = Some("This device's token limit for today on this computer's models is used up.".into());
                    return false;
                }
            }
            used.requests += requests;
            record.usage = Some(used);
            true
        })?;
        if let Some(message) = refusal { return Err(Fault::new("remote_limit_reached", message)); }
        Ok(Reservation { quota: self.clone(), device_id: exists.then(|| device_id.to_owned()), day, requests })
    }

    pub fn record(&self, device_id: &str, requests: f64, tokens: f64) -> Result<(), Fault> {
        count(requests)?; count(tokens)?;
        let day = (self.day)();
        self.store.update(device_id, &mut |record| {
            let mut used = today(record, &day);
            used.requests += requests;
            used.tokens += tokens;
            record.usage = Some(used);
            true
        })?;
        Ok(())
    }

    pub fn set_limits(&self, device_id: &str, limits: Limits) -> Result<bool, Fault> {
        if let Some(value) = limits.requests_per_day { count(value)?; }
        if let Some(value) = limits.tokens_per_day { count(value)?; }
        self.store.update(device_id, &mut |record| {
            record.limits = (limits.requests_per_day.is_some() || limits.tokens_per_day.is_some()).then(|| limits.clone());
            true
        })
    }
}

#[must_use = "Keep the reservation until work succeeds, or consume it with refund on failure"]
pub struct Reservation {
    quota: PeerQuota,
    device_id: Option<String>,
    day: String,
    requests: f64,
}

impl Reservation {
    pub fn refund(self) -> Result<(), Fault> {
        let Some(device_id) = self.device_id else { return Ok(()); };
        self.quota.store.update(&device_id, &mut |record| {
            let Some(usage) = record.usage.as_mut().filter(|usage| usage.day == self.day) else { return false; };
            usage.requests = (usage.requests - self.requests).max(0.0);
            true
        })?;
        Ok(())
    }
}

/// The host's original token policy. Only the runner's message_end enters this function; views never charge it.
pub fn assistant_tokens(event: &Value) -> f64 {
    if event["type"] != "message_end" || event["message"]["role"] != "assistant" { return 0.0; }
    event["message"]["usage"]["totalTokens"].as_f64().filter(|n| n.is_finite() && *n > 0.0).unwrap_or(0.0)
}

/// Unknown commands spend one request, matching quota-commands.ts's fail-closed policy.
pub fn command_uses_model(command: &Value) -> bool {
    let nonempty = |key: &str| command[key].as_str().is_some_and(|s| !crate::fs::order::js_trim(s).is_empty());
    match command["type"].as_str() {
        Some("switch_leaf") => command["summarize"] == true,
        Some("plan_approval") => if command["approved"] == true { command["option"] != "save" } else { nonempty("feedback") },
        Some("set_autopilot") => matches!(command["action"].as_str(), Some("start" | "resume")),
        Some("set_goal") => nonempty("objective") || command["action"] == "resume",
        Some(kind) => !FREE_COMMANDS.contains(&kind),
        None => true,
    }
}

const FREE_COMMANDS: &[&str] = &[
    "judge_available", "auto_mode_undo", "auto_mode_end", "agent_control_confirm", "agent_control_note",
    "agent_control_worker", "agent_control_turn", "agent_control_sent", "agent_control_attachment", "agent_control_answer",
    "autopilot_bridge", "agent_control_review", "agent_control_family_edits", "abort", "abort_and_restore_queue",
    "abort_bash", "abort_eval", "abort_maintenance", "abort_retry", "abort_subagent", "add_directory", "bash", "branch",
    "browser_relay_start", "browser_relay_stop", "btw_cancel", "cancel_job", "cancel_next_prompt", "clear_agent_worktrees",
    "clear_context", "compaction_limits", "cycle_model", "cycle_thinking_level", "debug", "delete_agent_file",
    "delete_plugin_setting", "dequeue", "discard_session_archive", "dump_session_archive", "eval", "export_html", "fork",
    "fork_from", "fresh", "get_active_tools", "get_agent_authoring", "get_agent_definition", "get_agent_definitions",
    "get_agent_worktrees", "get_available_commands", "get_available_models", "get_branch_messages", "get_btw_history",
    "get_command_arg_completions", "get_compaction_points", "get_context_entry", "get_context_files", "get_context_inspect",
    "get_context_report", "get_copy_targets", "get_autopilot", "get_checkout_peers", "autopilot_branch_status",
    "get_desktop_slot", "desktop_slot_stop", "desktop_slot_retry", "desktop_slot_kill", "desktop_slot_bridge",
    "get_advisor_stats", "get_delegation", "get_directories", "get_force_tool", "get_git_changes", "get_git_diff",
    "get_git_fingerprint", "get_git_unlanded", "get_turn_edits", "get_git_status", "get_goal", "get_gui_themes",
    "get_hooks", "get_jobs", "get_last_link", "get_login_providers", "get_marketplaces", "get_mcp_servers",
    "get_model_role_metadata", "get_model_roles", "get_model_setup_facts", "get_next_prompt", "get_omp_update",
    "get_orphan_worktrees", "get_saved_worktrees", "get_plan_mode", "get_plugin_detail", "get_plugin_doctor", "get_plugins",
    "get_prompt_templates", "get_provider_accounts", "get_providers", "get_queue", "get_recent_models",
    "get_security_dashboard", "get_security_scan", "get_session_stats", "get_session_tree", "get_settings",
    "get_settings_schema", "get_skill_detail", "get_skills", "get_ssh_hosts", "get_session_spend", "get_state",
    "get_last_assistant_text", "get_subagent_messages", "get_subagent_transcript", "get_subagents", "get_theme_colors",
    "get_transcript", "get_transcript_page", "get_usage", "git_branch", "git_branches", "git_commit", "git_commit_detail",
    "git_commit_diff", "git_discard", "git_history_action", "git_last_commit_message", "git_log", "git_operation",
    "git_remote", "git_stage", "git_stash", "git_undo_commit", "git_unstage", "github", "history_recent",
    "history_record", "history_search", "import_foreign_session", "install_agent_templates", "list_foreign_sessions",
    "live_mute", "live_stop", "login", "login_cancel", "logout", "manage_skill", "marketplace_action", "mcp_action",
    "mcp_add", "mcp_reauth", "mcp_reauth_cancel", "mcp_reload", "mcp_test", "move_session", "negotiate_protocol",
    "new_session", "pr_checkout", "pr_comment", "pr_comments", "pr_create", "pr_diff", "pr_edit", "pr_get", "pr_list",
    "pr_merge", "pr_repo", "pr_review", "preview_share_session", "promote_queued_message", "prompt_origin_set",
    "queue_clear", "queue_edit", "queue_move", "queue_remove", "read_agent_file", "read_image_blob", "redeem_reset_pass",
    "reload_plugins", "remove_directory", "remove_orphan_worktree", "restore_saved_worktree", "remove_queued_message",
    "resolve_local_url", "revive_subagent", "security_cancel", "security_set_disposition", "set_agents_paused",
    "set_ask_dialog", "set_auto_compaction", "set_auto_retry", "set_context_file_enabled", "set_delegation",
    "set_entry_label", "set_event_filter", "set_fast_mode", "set_follow_up_mode", "set_force_tool", "set_hook_enabled",
    "set_host_tools", "set_idle_compaction_draft", "set_interrupt_mode", "set_model", "set_model_role",
    "set_next_prompt_children", "set_next_prompt_draft", "set_output_style", "set_plan_mode", "set_plugin_enabled",
    "set_plugin_features", "set_plugin_setting", "set_prewalk", "set_session_name", "set_session_pinned", "set_setting",
    "set_skill_enabled", "set_slow_mode", "set_steering_mode", "set_subagent_subscription", "set_thinking_level",
    "set_todos", "set_ultrafast_mode", "shake_context", "share_session", "ssh_manage", "ssh_test", "stt_prepare",
    "switch_session", "typed_prompt", "worktree_create", "worktree_lifecycle_settings", "worktree_remove", "write_agent_file",
    "write_local_paste",
];

#[cfg(test)]
mod tests;
