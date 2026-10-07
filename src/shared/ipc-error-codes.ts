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
	"session_delete_cancelled",
	"session_name_empty",
	"session_starting",
	"session_owned_elsewhere",
	"session_kind_mismatch",
	"sidecar_not_connected",
	"sidecar_not_ready",
	"no_workspace",
	"path_escapes_workspace",
	"file_not_found",
	"not_a_directory",
	// LocalCommandError codes (src/main/local) that reach toasts unchanged.
	"busy",
	"gh_missing",
	"no_github_remote",
	"not_a_repo",
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
