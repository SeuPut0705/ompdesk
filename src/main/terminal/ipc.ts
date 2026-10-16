import {
	TERMINAL_OUTPUT_BUDGET,
	TERMINAL_POLL_MAX_WAIT_MS,
	type TerminalOperation,
	type TerminalShell,
	type TerminalSnapshot,
} from "../../shared/terminal-types";
import type { RemoteDevices } from "../remote/devices";
import type { SidecarPool } from "../sidecar-pool";
import { isWebWindow } from "../web/client-window";
import type { IpcRegistry } from "../web/ipc-registry";
import { TerminalLease } from "./lease";
import { disposeTerminals, terminalRequest, validTerminalOperation } from "./requests";
import { detectShells } from "./shells";

const owners = new Set<string>();
/** Who sizes each PTY when several windows show it (lease.ts); keyed `<owner>|<session id>`. */
const lease = new TerminalLease();
export function closeTabTerminals(windowId: number, tabId: string): void {
	const owner = `${windowId}:${tabId}`;
	lease.forgetOwner(`${owner}|`);
	if (owners.delete(owner)) disposeTerminals(owner);
}
/**
 * The full output of a tab's Terminal panel sessions, for the read-only agent tool (C115):
 * a local tab's in this window, a paired host's tab's on that host.
 */
export async function readTabTerminals(
	remoteDevices: Pick<RemoteDevices, "request">,
	tab: { tabId: string; webContentsId: number; cwd: string; device: string | undefined },
): Promise<TerminalSnapshot[]> {
	const operation: TerminalOperation = { action: "list" };
	if (tab.device)
		return remoteDevices.request<TerminalSnapshot[]>(tab.device, "terminal.request", { rtab: tab.tabId, operation });
	const owner = `${tab.webContentsId}:${tab.tabId}`;
	return owners.has(owner) ? terminalRequest(owner, tab.cwd, operation) : [];
}
export function registerTerminalIpc(
	ipc: IpcRegistry,
	pool: SidecarPool,
	remoteDevices: Pick<RemoteDevices, "request">,
): void {
	const released = pool.onTabReleased;
	pool.onTabReleased = (tabId, exited) => {
		for (const owner of owners) {
			if (!owner.endsWith(`:${tabId}`)) continue;
			owners.delete(owner);
			lease.forgetOwner(`${owner}|`);
			disposeTerminals(owner);
		}
		released?.(tabId, exited);
	};
	// A paired host's tab lists and runs the host's shells (C114).
	ipc.handle("terminal:shells", async (caller, tabId?: string): Promise<TerminalShell[]> => {
		const win = caller.win;
		const target = win && typeof tabId === "string" ? pool.tabTarget(win, tabId) : null;
		if (target?.device) return remoteDevices.request<TerminalShell[]>(target.device, "terminal.shells", {});
		return detectShells();
	});
	ipc.handle("terminal:request", async (caller, tabId: string, operation: TerminalOperation) => {
		const win = caller.win;
		const target = win && typeof tabId === "string" ? pool.tabTarget(win, tabId) : null;
		if (!target) throw new Error("Terminal tab not found");
		if (!validTerminalOperation(operation)) throw new Error("Invalid terminal operation");
		// The host owns the PTYs of its tabs and disposes them with the tab.
		if (target.device)
			return remoteDevices.request<TerminalSnapshot[]>(target.device, "terminal.request", {
				rtab: tabId,
				operation,
			});
		// The tab's PTYs are one set whichever window shows it (multi-viewer), keyed by its owner window;
		// the owner's page going away closes them, a viewer's does not.
		const owner = `${target.winId}:${tabId}`;
		if (!owners.has(owner)) {
			owners.add(owner);
			if (caller.sender.id === target.winId)
				caller.sender.once("destroyed", () => closeTabTerminals(target.winId, tabId));
		}
		const viewer = caller.sender.id;
		const session = (id: string) => `${owner}|${id}`;
		// A web viewer's list is a long poll with an output budget, whatever it asked for (the acknowledgement is
		// its next request); a desktop window's list keeps the plain read.
		let forwarded: TerminalOperation = operation;
		if (operation.action === "list" && isWebWindow(viewer)) {
			forwarded = {
				...operation,
				waitMs: Math.min(operation.waitMs ?? 0, TERMINAL_POLL_MAX_WAIT_MS),
				budget: Math.min(operation.budget ?? TERMINAL_OUTPUT_BUDGET, TERMINAL_OUTPUT_BUDGET),
			};
		} else if (operation.action === "resize" && !lease.mayResize(session(operation.id), viewer)) {
			// Another viewer sizes this PTY: the resize is dropped and the answer says who has it.
			forwarded = { action: "list", offsets: {} };
		} else if (operation.action === "claim") {
			lease.claim(session(operation.id), viewer);
			forwarded = { action: "list", offsets: {} };
		} else if (operation.action === "write") {
			lease.typed(session(operation.id), viewer);
		} else if (operation.action === "close") {
			lease.forget(session(operation.id));
		}
		const result = await terminalRequest(owner, target.sidecar.cwd, forwarded);
		// A tab can close while the lazy Bun worker is starting.
		if (!owners.has(owner)) {
			disposeTerminals(owner);
			return [];
		}
		return result.map(snapshot => ({ ...snapshot, lease: lease.seen(session(snapshot.id), viewer) }));
	});
}
