import { BrowserWindow, ipcMain } from "electron";
import type { TerminalOperation, TerminalShell, TerminalSnapshot } from "../../shared/terminal-types";
import type { RemoteDevices } from "../remote/devices";
import type { SidecarPool } from "../sidecar-pool";
import { disposeTerminals, terminalRequest, validTerminalOperation } from "./requests";
import { detectShells } from "./shells";

const owners = new Set<string>();
export function closeTabTerminals(windowId: number, tabId: string): void {
	const owner = `${windowId}:${tabId}`;
	if (owners.delete(owner)) disposeTerminals(owner);
}
export function registerTerminalIpc(pool: SidecarPool, remoteDevices: Pick<RemoteDevices, "request">): void {
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
	ipcMain.handle("terminal:shells", async (event, tabId?: string): Promise<TerminalShell[]> => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const target = win && typeof tabId === "string" ? pool.tabTarget(win, tabId) : null;
		if (target?.device) return remoteDevices.request<TerminalShell[]>(target.device, "terminal.shells", {});
		return detectShells();
	});
	ipcMain.handle("terminal:request", async (event, tabId: string, operation: TerminalOperation) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const target = win && typeof tabId === "string" ? pool.tabTarget(win, tabId) : null;
		if (!target) throw new Error("Terminal tab not found");
		if (!validTerminalOperation(operation)) throw new Error("Invalid terminal operation");
		// The host owns the PTYs of its tabs and disposes them with the tab.
		if (target.device)
			return remoteDevices.request<TerminalSnapshot[]>(target.device, "terminal.request", {
				rtab: tabId,
				operation,
			});
		const owner = `${event.sender.id}:${tabId}`;
		if (!owners.has(owner)) {
			owners.add(owner);
			event.sender.once("destroyed", () => closeTabTerminals(event.sender.id, tabId));
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
