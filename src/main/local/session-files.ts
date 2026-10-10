/**
 * Stored (not live) session rename through stock RPC. Deletion uses the stock session-store helper.
 */
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DEFAULT_ROLE_MODEL_SELECTOR, parseModelRestoreFailure } from "../../shared/model-restore";
import type { OmpRuntime } from "./types";

const SESSION_EXT = ".jsonl";
const RENAME_TIMEOUT_MS = 30_000;
const RENAME_REQUEST_ID = "gui-rename";
/** A bare `omp --mode rpc` over one session file: nothing the rename does not need. */
const RENAME_ARGS = [
	"--mode",
	"rpc",
	"--no-tools",
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-lsp",
	"--no-title",
];

/** The `set_session_name` response in a short-lived omp's stdout, or undefined when it never answered. */
function renameResponse(stdout: string): { success: boolean; error?: string } | undefined {
	for (const line of stdout.split("\n")) {
		if (!line.includes(RENAME_REQUEST_ID)) continue;
		try {
			const frame: unknown = JSON.parse(line);
			if (typeof frame !== "object" || frame === null || !("type" in frame) || frame.type !== "response") continue;
			if (!("id" in frame) || frame.id !== RENAME_REQUEST_ID) continue;
			const success = "success" in frame && frame.success === true;
			const error = "error" in frame && typeof frame.error === "string" ? frame.error : undefined;
			return { success, error };
		} catch {
			// Not a frame.
		}
	}
	return undefined;
}

/**
 * Rename a session no omp process has open. omp persists a title in a header
 * slot, a `title_change` entry and its title index, so the rename runs stock
 * `set_session_name` in a short-lived `omp --mode rpc --session <path>` that
 * exits when its stdin closes. Keep only GUI recovery around that stock command:
 * stock session restoration fails closed when the saved model is gone, so the
 * offline rename retries with an explicit default model (never records a model change).
 */
export async function renameStoredSession(omp: OmpRuntime, sessionPath: string, name: string): Promise<void> {
	const title = name.trim();
	if (!title) throw new Error("Session name cannot be empty");
	if (!sessionPath.endsWith(SESSION_EXT)) throw new Error("Invalid session path");
	// omp would start a fresh session at a missing path rather than fail.
	await access(sessionPath).catch(() => {
		throw new Error("Session file not found");
	});
	const input = `${JSON.stringify({ id: RENAME_REQUEST_ID, type: "set_session_name", name: title })}\n`;
	const opts = { cwd: tmpdir(), input, timeoutMs: RENAME_TIMEOUT_MS, env: { PI_NOTIFICATIONS: "off" } };
	let output = await omp.run([...RENAME_ARGS, "--session", sessionPath], opts);
	let response = renameResponse(output.stdout);
	if (!response && parseModelRestoreFailure(output.stderr)) {
		output = await omp.run([...RENAME_ARGS, "--session", sessionPath, "--model", DEFAULT_ROLE_MODEL_SELECTOR], opts);
		response = renameResponse(output.stdout);
	}
	if (!response) {
		const detail = output.stderr.trim().split("\n")[0] ?? "";
		throw new Error(`omp could not open the session to rename it${detail ? `: ${detail}` : ""}`);
	}
	if (!response.success) throw new Error(response.error ?? "Session rename failed");
}
