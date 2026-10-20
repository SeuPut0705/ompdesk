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
import { codedError, ipcErrorCode } from "../shared/ipc-error-codes";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import { deletedSessions } from "./deleted-sessions";
import type { RpcClient } from "./rpc-client";
import type { SidecarPool } from "./sidecar-pool";

export type SessionTabs = Pick<
	SidecarPool,
	"sessionOwner" | "sessionOwnerIsLive" | "sessionRunning" | "commandForSession" | "closeSessionTab"
>;

/** The tabs this computer runs for paired devices (LocalHostServices), as this computer's own delete closes them. */
export interface DeviceSessionTabs {
	closeSessionTabs(sessionPath: string): Promise<void>;
}

/**
 * `deviceTabs`: this computer's own delete of its own session. The paired devices' tabs on it here close first,
 * idle ones only, as another window's tab would; nothing closes while this computer's own tab runs it.
 */
export async function deleteSession(
	tabs: SessionTabs,
	sessionPath: string,
	device: string | undefined,
	deleteStored: () => Promise<unknown>,
	deviceTabs?: DeviceSessionTabs,
): Promise<void> {
	if (deviceTabs) {
		if (tabs.sessionRunning(sessionPath, device)) throw codedError("session_running", "Session is currently running");
		await deviceTabs.closeSessionTabs(sessionPath);
	}
	if (!(await tabs.closeSessionTab(sessionPath, device)))
		throw codedError("session_running", "Session is currently running");
	await deleteStored();
	// Gone for good: no layout, marker, device or index may bring it back (deleted-sessions.ts).
	deletedSessions().add(sessionPath, device);
}

type SessionDeleteLog = (outcome: "deleted" | "refused" | "failed", details: Record<string, string>) => void;
let deleteLog: SessionDeleteLog | null = null;

/** Where `recordSessionDelete` writes (index.ts: the runtime log, source `session-delete`); null stops it. */
export function setSessionDeleteLog(log: SessionDeleteLog | null): void {
	deleteLog = log;
}

/**
 * Run one session delete and leave one line for it: the machine the file is on (`device`, `local` for this one), the
 * paired device that asked (`by`), the file's name only, and the outcome, a refusal's code or a failure's message.
 */
export async function recordSessionDelete(
	target: { sessionPath: string; device?: string; by?: string },
	run: () => Promise<unknown>,
): Promise<void> {
	const details: Record<string, string> = {
		device: target.device ?? "local",
		...(target.by ? { by: target.by } : {}),
		session: target.sessionPath.split(/[\\/]/).at(-1) ?? "",
	};
	try {
		await run();
	} catch (error) {
		const code = ipcErrorCode(error);
		if (code) deleteLog?.("refused", { ...details, reason: code });
		else deleteLog?.("failed", { ...details, reason: error instanceof Error ? error.message : String(error) });
		throw error;
	}
	deleteLog?.("deleted", details);
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
