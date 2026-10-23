/**
 * Stable codes for main-process failures the renderer shows to the user.
 * Main keeps an English text for logs; the renderer maps the code to its own
 * localized sentence (`ipcError.<code>` in the locale files) and keeps the
 * English text only as the toast's or banner's raw detail line.
 *
 * Two carriers, one parser:
 * - result objects (`RpcResponseError`, `IpcOpenPathResult`, …) set `code`;
 * - `ipcMain.handle` throws, where Electron forwards only the message, use
 *   `codedError()`, which prefixes the message with `[code] `.
 */

export const IPC_ERROR_CODES = [
	"invalid_session_path",
	"session_running",
	"session_deleted",
	"session_folder_missing",
	"worktree_removing",
	"session_delete_cancelled",
	"session_name_empty",
	"session_starting",
	"session_owned_elsewhere",
	"session_kind_mismatch",
	"session_open_in_tab",
	"session_hidden",
	"session_not_open",
	"no_messages",
	"sidecar_not_connected",
	"sidecar_not_ready",
	"no_workspace",
	"path_escapes_workspace",
	"file_not_found",
	"not_a_directory",
	"empty_path",
	"not_absolute_path",
	"not_a_file",
	"image_too_large",
	"unsupported_image",
	"file_too_large",
	// A paired host refused a file attached to a prompt there (its daily upload limit, an empty file).
	"upload_refused",
	"path_escapes_roots",
	"unknown_tab",
	"no_window",
	"invalid_path",
	"invalid_regex",
	"changed_on_disk",
	"invalid_stats_path",
	"invalid_preference_key",
	"invalid_launch_profile",
	"editor_unset",
	"benchmark_model_count",
	"benchmark_invalid_model",
	"benchmark_invalid_option",
	"benchmark_running",
	"model_setup_running",
	"model_setup_invalid",
	"model_setup_no_plan",
	"provider_id_builtin",
	"provider_builtin_delete",
	"stats_not_ready",
	"stats_api_error",
	"safe_storage_unavailable",
	// LocalCommandError codes (src/main/local) that reach toasts unchanged.
	"busy",
	"gh_missing",
	"gh_unauthenticated",
	"no_github_remote",
	"not_a_repo",
	"exists",
	"invalid_name",
	"not_a_worktree",
	"path_outside",
	"worktree_create_failed",
	"pr_not_found",
	"pr_draft_failed",
	"pr_create_failed",
	"pr_checkout_failed",
	"pr_merge_failed",
	"pr_review_failed",
	"pr_edit_failed",
	"git_failed",
	"push_rejected",
	"no_remote",
	"detached_head",
	"nothing_staged",
	"commit_message_failed",
	"branch_checked_out",
	"unsupported",
	"invalid_content",
	"invalid_scope",
	"not_editable",
	"source_unavailable",
	"stale_cursor",
	"oauth_busy",
	"update_check_failed",
	"worktree_outside_root",
	"worktree_dirty",
	"worktree_remove_failed",
	"bridge_unavailable",
	"unsupported_omp",
	// Remote devices (src/main/remote): link failures, and a host's refusal (protocol.ts REFUSAL_CODES).
	"remote_offline",
	"remote_unknown_device",
	"remote_path_native",
	"remote_unreachable",
	"remote_protocol",
	"remote_not_tailnet",
	"remote_no_identity",
	"remote_not_allowed",
	"remote_blocked",
	"remote_declined",
	"remote_key_mismatch",
	"remote_tailscale_off",
	// A paired device's daily model-use limit on this host is used up (remote/peer-quota.ts).
	"remote_limit_reached",
	// A device asked a host to install its update (machine-services.ts desktopUpdate).
	"host_busy",
	"update_not_ready",
	// Another window that shows the tab answered this ask or approval first (multi-viewer, sidecar-pool.ts).
	"already_answered",
	// A paired web device asked for something its grants or the web policy do not allow (main/web/ws-router.ts).
	"web_forbidden",
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

const KNOWN_CODES: readonly string[] = IPC_ERROR_CODES;
/** `[code] ` marker at the start of a message (after Electron's own prefixes). */
const CODED_MESSAGE = /\[([a-z_]+)\] /;

export function isIpcErrorCode(value: unknown): value is IpcErrorCode {
	return typeof value === "string" && KNOWN_CODES.includes(value);
}

/** An Error whose code survives Electron's message-only IPC serialization. */
export function codedError(code: IpcErrorCode, message: string): Error {
	return new Error(`[${code}] ${message}`);
}

/** The code of a failure: a result object's `code` field, or a `[code]` marker in an error message. */
export function ipcErrorCode(error: unknown): IpcErrorCode | undefined {
	if (error == null) return undefined;
	if (typeof error === "object" && !(error instanceof Error)) {
		if ("code" in error && isIpcErrorCode(error.code)) return error.code;
		return "error" in error && typeof error.error === "string" ? ipcErrorCode(error.error) : undefined;
	}
	const match = CODED_MESSAGE.exec(error instanceof Error ? error.message : String(error));
	return match && isIpcErrorCode(match[1]) ? match[1] : undefined;
}
