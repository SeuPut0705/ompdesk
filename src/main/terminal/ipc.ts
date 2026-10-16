import type { TerminalOperation, TerminalShell, TerminalSnapshot } from "../../shared/terminal-types";
import type { RemoteDevices } from "../remote/devices";
import type { SidecarPool } from "../sidecar-pool";
import type { IpcRegistry } from "../web/ipc-registry";
import { disposeTerminals, terminalRequest, validTerminalOperation } from "./requests";
import { detectShells } from "./shells";

const owners = new Set<string>();
export function closeTabTerminals(windowId: number, tabId: string): void {
	const owner = `${windowId}:${tabId}`;
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
		const owner = `${caller.sender.id}:${tabId}`;
		if (!owners.has(owner)) {
			owners.add(owner);
			caller.sender.once("destroyed", () => closeTabTerminals(caller.sender.id, tabId));
		}
		const result = await terminalRequest(owner, target.sidecar.cwd, operation);
		// A tab can close while the lazy Bun worker is starting.
		if (!owners.has(owner)) {
			disposeTerminals(owner);
			return [];
		}
		return result;
	});
}
