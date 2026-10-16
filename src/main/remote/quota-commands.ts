/**
 * Which RPC commands spend a model request on this computer (D65). A paired device's
 * `tab.command` goes to the host's omp verbatim, so the daily limit has to know every
 * command type: `RpcCommand["type"]` must appear in exactly one of the three lists
 * below, and the type check at the end of the file (plus `quota-commands.test.ts`,
 * which reads the union out of `src/shared/rpc-types.ts`) fails when a new command
 * is added without deciding whether it calls a model.
 *
 * Not covered: terminals (`terminal.request` runs the user's shell, where a device can
 * type `omp -p …` itself) and the agent's own `bash`/`eval`. They run arbitrary
 * programs on the host, which a request count cannot meter.
 */
import type { RpcCommand } from "../../shared/rpc-types";

type RpcType = RpcCommand["type"];

/** Commands that always start a model call (a turn, an ephemeral turn, a background job, a draft, speech). */
export const MODEL_COMMAND_TYPES = [
	"prompt",
	"abort_and_prompt",
	"steer",
	"follow_up",
	"steer_subagent",
	"btw",
	"compact",
	"retry",
	"handoff",
	"security_validate",
	// Bridge `modes/actions.ts`: `/omfg` runs `session.runEphemeralTurn` up to three times; `/tan` dispatches a background job.
	"omfg",
	"tan",
	// Stock `restoreSession` continues the turn the last process was cut off in.
	"restore_interrupted",
	// The security coordinator runs scan agents; `guided_goal` sends the kickoff turn.
	"security_start",
	"guided_goal",
	// Speech to text, text to speech and the realtime session go through a model provider.
	"transcribe_audio",
	"synthesize_speech",
	"live_start",
	// Main-side local handlers that run a model through stock `omp` (PR text, `omp commit --dry-run`).
	"pr_draft",
	"git_commit_message",
	// The built-in prompt suggestions (bridge modes/next-prompt.ts): a cheap request on the `smol` role model.
	"complete_inline",
	"refresh_next_prompt",
	// The automatic title (bridge modes/auto-title.ts): `/rename` without a title runs the cheap title model.
	"regenerate_session_title",
	// The automatic mode choice (bridge modes/auto-mode.ts): one cheap judge request on the host per typed prompt.
	"auto_mode_decide",
	// Stock `MemoryBackend.enqueue` (`/memory enqueue`): consolidation runs a model (mnemopi's fact extraction, the
	// hindsight server, the local backend's next consolidation pass).
	"memory_enqueue",
] as const satisfies readonly RpcType[];

/** Commands that call a model only for some arguments; `commandUsesModel` decides. */
export const CONDITIONAL_MODEL_COMMAND_TYPES = [
	// `summarize: true` summarizes the abandoned branch (`navigateTree`).
	"switch_leaf",
	// Approving to execute or compact sends the plan prompt; a rejection with feedback sends it as a turn.
	"plan_approval",
	// An objective or a resume starts a goal turn; budgets, limits, pause and drop do not.
	"set_goal",
	// Turning the loop on sends its first prompt.
	"set_loop_mode",
] as const satisfies readonly RpcType[];

/** Commands that never call a model: reads, settings, git, files, queue edits, session moves. */
export const QUOTA_FREE_COMMAND_TYPES = [
	// The chip's undo: leaves the mode and marks the session; no model.
	"auto_mode_undo",
	"abort",
	"abort_and_restore_queue",
	"abort_bash",
	"abort_eval",
	"abort_maintenance",
	"abort_retry",
	"abort_subagent",
	"add_directory",
	"bash",
	"branch",
	"browser_relay_start",
	"browser_relay_stop",
	"btw_cancel",
	"cancel_job",
	"cancel_next_prompt",
	"clear_agent_worktrees",
	"clear_context",
	"compaction_limits",
	"cycle_model",
	"cycle_thinking_level",
	"debug",
	"define_model_role",
	"delete_agent_file",
	"delete_plugin_setting",
	"dequeue",
	"drop_session",
	"eval",
	"export_html",
	"forget_model_role",
	"fork",
	"fork_from",
	"fresh",
	"get_active_tools",
	"get_agent_authoring",
	"get_agent_definition",
	"get_agent_definitions",
	"get_agent_worktrees",
	"get_available_commands",
	"get_available_models",
	"get_branch_messages",
	"get_btw_history",
	"get_command_arg_completions",
	"get_compaction_points",
	"get_context_entry",
	"get_context_files",
	"get_context_inspect",
	"get_context_report",
	"get_copy_targets",
	"get_delegation",
	"get_directories",
	"get_force_tool",
	"get_git_changes",
	"get_git_diff",
	"get_git_fingerprint",
	"get_git_status",
	"get_goal",
	"get_gui_themes",
	"get_hooks",
	"get_jobs",
	"get_last_link",
	"get_login_providers",
	"get_loop_mode",
	"get_marketplaces",
	"get_mcp_servers",
	"get_memory_report",
	"get_model_role_metadata",
	"get_model_roles",
	"get_next_prompt",
	"get_omp_update",
	"get_plan_mode",
	"get_plugin_detail",
	"get_plugin_doctor",
	"get_plugins",
	"get_prompt_templates",
	"get_provider_accounts",
	"get_providers",
	"get_queue",
	"get_recent_models",
	"get_security_dashboard",
	"get_security_scan",
	"get_session_stats",
	"get_session_tree",
	"get_settings",
	"get_settings_schema",
	"get_skill_detail",
	"get_skills",
	"get_ssh_hosts",
	"get_state",
	"get_subagent_messages",
	"get_subagent_transcript",
	"get_subagents",
	"get_theme_colors",
	"get_transcript",
	"get_transcript_page",
	"get_usage",
	"get_vibe_mode",
	"git_branch",
	"git_branches",
	"git_commit",
	"git_commit_detail",
	"git_commit_diff",
	"git_discard",
	"git_history_action",
	"git_last_commit_message",
	"git_log",
	"git_operation",
	"git_remote",
	"git_stage",
	"git_stash",
	"git_undo_commit",
	"git_unstage",
	"github",
	"history_recent",
	"history_record",
	"history_search",
	"import_foreign_session",
	"install_agent_templates",
	"list_foreign_sessions",
	"live_mute",
	"live_stop",
	"login",
	"login_cancel",
	"logout",
	"manage_skill",
	"marketplace_action",
	"mcp_action",
	"mcp_add",
	"mcp_reauth",
	"mcp_reauth_cancel",
	"mcp_test",
	"memory_clear",
	"memory_queue",
	"memory_save",
	"memory_search",
	"move_session",
	"negotiate_protocol",
	"new_session",
	"pr_checkout",
	"pr_comment",
	"pr_comments",
	"pr_create",
	"pr_diff",
	"pr_edit",
	"pr_get",
	"pr_list",
	"pr_merge",
	"pr_repo",
	"pr_review",
	"preview_share_session",
	"promote_queued_message",
	"queue_clear",
	"queue_edit",
	"queue_move",
	"queue_remove",
	"read_agent_file",
	"redeem_reset_pass",
	"reload_plugins",
	"remove_directory",
	"remove_queued_message",
	"resolve_local_url",
	// Stock `AgentLifecycleManager.ensureLive` rebuilds a parked subagent's session from its file; no prompt is sent.
	"revive_subagent",
	"security_cancel",
	"security_set_disposition",
	"set_agents_paused",
	"set_ask_dialog",
	"set_auto_compaction",
	"set_auto_retry",
	"set_context_file_enabled",
	"set_delegation",
	"set_entry_label",
	"set_event_filter",
	"set_fast_mode",
	"set_follow_up_mode",
	"set_force_tool",
	"set_hook_enabled",
	"set_host_tools",
	"set_idle_compaction_draft",
	"set_interrupt_mode",
	"set_model",
	"set_model_role",
	"set_next_prompt_draft",
	"set_output_style",
	"set_plan_mode",
	"set_plugin_enabled",
	"set_plugin_features",
	"set_plugin_setting",
	"set_prewalk",
	"set_session_name",
	"set_session_pinned",
	"set_setting",
	"set_skill_enabled",
	"set_slow_mode",
	"set_steering_mode",
	"set_subagent_subscription",
	"set_thinking_level",
	"set_todos",
	"set_ultrafast_mode",
	"set_vibe_mode",
	"shake_context",
	"share_session",
	"ssh_manage",
	"ssh_test",
	"switch_session",
	"worktree_create",
	"worktree_lifecycle_settings",
	"worktree_remove",
	"write_agent_file",
	"write_local_paste",
] as const satisfies readonly RpcType[];

type Classified =
	| (typeof MODEL_COMMAND_TYPES)[number]
	| (typeof CONDITIONAL_MODEL_COMMAND_TYPES)[number]
	| (typeof QUOTA_FREE_COMMAND_TYPES)[number];

/** A compile error naming the command types no list covers. */
const everyCommandClassified: [Exclude<RpcType, Classified>] extends [never] ? true : Exclude<RpcType, Classified> =
	true;
void everyCommandClassified;

/**
 * Whether the command costs the device one model request. A type no list knows (a client
 * newer than this host) counts: the limit fails closed.
 */
export function commandUsesModel(command: RpcCommand): boolean {
	switch (command.type) {
		case "switch_leaf":
			return command.summarize === true;
		case "plan_approval":
			return command.approved === true
				? command.option !== "save"
				: typeof command.feedback === "string" && command.feedback.trim() !== "";
		case "set_goal":
			return (
				(typeof command.objective === "string" && command.objective.trim() !== "") || command.action === "resume"
			);
		case "set_loop_mode":
			return command.enabled === true;
		default:
			return (
				(MODEL_COMMAND_TYPES as readonly string[]).includes(command.type) ||
				!(QUOTA_FREE_COMMAND_TYPES as readonly string[]).includes(command.type)
			);
	}
}
