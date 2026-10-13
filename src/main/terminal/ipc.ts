import { BrowserWindow, ipcMain } from "electron";
import type { TerminalOperation, TerminalSnapshot } from "../../shared/terminal-types";
import type { SidecarPool } from "../sidecar-pool";
import { stockHelperRequest } from "../stock-helper";

const owners = new Set<string>();
export function closeTabTerminals(windowId: number, tabId: string): void {
	const owner = `${windowId}:${tabId}`;
	if (!owners.delete(owner)) return;
	void stockHelperRequest("terminal.dispose", { owner }).catch(() => {});
}
function validOperation(value: TerminalOperation): boolean {
	if (!value || typeof value !== "object") return false;
	if (value.action === "list")
		return (
			value.offsets === undefined ||
			(typeof value.offsets === "object" &&
				value.offsets !== null &&
				Object.values(value.offsets).every(offset => Number.isSafeInteger(offset) && offset >= 0))
		);
	if (value.action !== "create" && typeof value.id !== "string") return false;
	if (value.action === "create" || value.action === "resize")
		return (
			Number.isInteger(value.cols) &&
			value.cols > 0 &&
			value.cols <= 1000 &&
			Number.isInteger(value.rows) &&
			value.rows > 0 &&
			value.rows <= 1000
		);
	if (value.action === "write") return typeof value.data === "string" && value.data.length <= 1_000_000;
	return value.action === "close" || value.action === "restart" || value.action === "clear";
}
export function registerTerminalIpc(pool: SidecarPool): void {
	const released = pool.onTabReleased;
	pool.onTabReleased = (tabId, exited) => {
		for (const owner of owners) {
			if (!owner.endsWith(`:${tabId}`)) continue;
			owners.delete(owner);
			void stockHelperRequest("terminal.dispose", { owner }).catch(() => {});
		}
		released?.(tabId, exited);
	};
	ipcMain.handle("terminal:request", async (event, tabId: string, operation: TerminalOperation) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const target = win && typeof tabId === "string" ? pool.tabTarget(win, tabId) : null;
		if (!target) throw new Error("Terminal tab not found");
		if (target.device) throw new Error("Terminals are only available for local tabs");
		if (!validOperation(operation)) throw new Error("Invalid terminal operation");
		const owner = `${event.sender.id}:${tabId}`;
		if (!owners.has(owner)) {
			owners.add(owner);
			event.sender.once("destroyed", () => closeTabTerminals(event.sender.id, tabId));
		}
		const result = await stockHelperRequest<TerminalSnapshot[]>("terminal.request", {
			owner,
			cwd: target.sidecar.cwd,
			operation,
		});
		// A tab can close while the lazy Bun worker is starting.
		if (!owners.has(owner)) {
			await stockHelperRequest("terminal.dispose", { owner });
			return [];
		}
		return result;
	});
}
