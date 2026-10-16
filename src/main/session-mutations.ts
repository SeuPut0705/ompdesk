/**
 * Deleting, renaming and moving a stored session, the same for this machine's
 * own sidebar (ipc.ts) and for a paired device using it as host
 * (remote/host-services.ts). A delete closes the tab holding the session, as
 * closing a tab does (the window drops it), waits for that omp to exit and
 * removes the stored file with stock: no replacement session is started. A
 * rename goes to a live owner's process in memory, else to the file. A move
 * needs the session closed: an open tab moves its own session with stock
 * `/move`. Callers keep their own path validation, device routing and peer
 * ownership checks.
 */
import { codedError } from "../shared/ipc-error-codes";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import type { RpcClient } from "./rpc-client";
import type { SidecarPool } from "./sidecar-pool";

export type SessionTabs = Pick<
	SidecarPool,
	"sessionOwner" | "sessionOwnerIsLive" | "commandForSession" | "closeSessionTab"
>;

export async function deleteSession(
	tabs: SessionTabs,
	sessionPath: string,
	device: string | undefined,
	deleteStored: () => Promise<unknown>,
): Promise<void> {
	if (!(await tabs.closeSessionTab(sessionPath, device)))
		throw codedError("session_running", "Session is currently running");
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
