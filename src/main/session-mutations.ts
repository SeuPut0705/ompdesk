/**
 * Deleting, renaming and moving a stored session, the same for this machine's
 * own sidebar (ipc.ts) and for a paired device using it as host
 * (remote/host-services.ts). A tab whose process has the session loaded gives
 * it up through `drop_session` / renames it in memory; otherwise the stored
 * file is the session, and any process-less tab's claim on it is dropped first
 * so that tab cannot wake into a path that no longer exists. A move needs the
 * session closed: an open tab moves its own session with stock `/move`.
 * Callers keep their own path validation, device routing and peer ownership checks.
 */
import { codedError } from "../shared/ipc-error-codes";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import type { RpcClient } from "./rpc-client";
import type { SidecarPool } from "./sidecar-pool";

export type SessionTabs = Pick<
	SidecarPool,
	"sessionOwner" | "sessionOwnerIsLive" | "commandForSession" | "commandForIdleSession" | "forgetSession"
>;

export async function deleteSession(
	tabs: SessionTabs,
	sessionPath: string,
	device: string | undefined,
	deleteStored: () => Promise<unknown>,
): Promise<void> {
	const owner = tabs.sessionOwner(sessionPath, device);
	if (owner && tabs.sessionOwnerIsLive(sessionPath, device)) {
		const response = await tabs.commandForIdleSession(sessionPath, { type: "drop_session" }, device);
		if (!response) throw codedError("session_running", "Session is currently running");
		if (!response.success) throw new Error(response.error);
		const data = response.data;
		if (typeof data === "object" && data !== null && "cancelled" in data && data.cancelled === true)
			throw codedError("session_delete_cancelled", "Session deletion was cancelled");
		// The owner moved on to a fresh session (drop_session reported its identity); a tab
		// that did not report it yet drops the deleted session's file, id and title.
		tabs.forgetSession(owner.tabId, sessionPath);
		return;
	}
	// A tab without a process: the file is the session, and the tab wakes into a fresh one.
	if (owner) tabs.forgetSession(owner.tabId, sessionPath);
	await deleteStored();
}

export interface RenameSessionOptions {
	device?: string;
	renameStored: (name: string) => Promise<unknown>;
	/**
	 * A live owner outside `tabs` (a host's tabs for paired devices): its
	 * client, null while it is still starting, undefined when there is none.
	 */
	otherOwner?: () => Pick<RpcClient, "command"> | null | undefined;
}

/** Stock renames mid-run (a user title also locks out the pending auto-title), so this never waits for idle. */
export async function renameSession(
	tabs: SessionTabs,
	sessionPath: string,
	rawName: unknown,
	options: RenameSessionOptions,
): Promise<void> {
	const name = typeof rawName === "string" ? rawName.trim() : "";
	if (!name) throw codedError("session_name_empty", "Session name cannot be empty");
	const { device } = options;
	const command: RpcCommand = { type: "set_session_name", name, sessionPath };
	const other = options.otherOwner?.();
	let response: RpcResponse | null | undefined;
	if (other !== undefined) response = other ? await other.command(command) : null;
	else if (tabs.sessionOwner(sessionPath, device) && tabs.sessionOwnerIsLive(sessionPath, device))
		response = await tabs.commandForSession(sessionPath, command, device);
	if (response === null) throw codedError("session_starting", "Session is still starting");
	if (response === undefined) await options.renameStored(name);
	else if (!response.success) throw new Error(response.error);
}

/** Move a stored session no tab holds; returns its new path. */
export async function moveSession(
	tabs: Pick<SessionTabs, "sessionOwner">,
	sessionPath: string,
	device: string | undefined,
	moveStored: () => Promise<string>,
): Promise<string> {
	if (tabs.sessionOwner(sessionPath, device)) throw codedError("session_open_in_tab", "Session is open in a tab");
	return moveStored();
}
