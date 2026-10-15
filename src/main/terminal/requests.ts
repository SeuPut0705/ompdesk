/**
 * Terminal operations against the stock helper's PTYs (stock `PtySession`), shared by this
 * machine's Terminal IPC (`ipc.ts`) and a paired device's tab served here (`remote/host-services.ts`).
 */
import type { TerminalOperation, TerminalSnapshot } from "../../shared/terminal-types";
import { stockHelperRequest } from "../stock-helper";
import { detectShells } from "./shells";

export function validTerminalOperation(value: TerminalOperation): boolean {
	if (!value || typeof value !== "object") return false;
	if (value.action === "list")
		return (
			value.offsets === undefined ||
			(typeof value.offsets === "object" &&
				value.offsets !== null &&
				Object.values(value.offsets).every(offset => Number.isSafeInteger(offset) && offset >= 0))
		);
	if (value.action !== "create" && typeof value.id !== "string") return false;
	if (value.action === "create" && value.shell !== undefined && typeof value.shell !== "string") return false;
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

/** One operation on `owner`'s terminals, a new one started in `cwd`. */
export function terminalRequest(owner: string, cwd: string, operation: TerminalOperation): Promise<TerminalSnapshot[]> {
	if (!validTerminalOperation(operation)) return Promise.reject(new Error("Invalid terminal operation"));
	return stockHelperRequest<TerminalSnapshot[]>("terminal.request", {
		owner,
		cwd,
		operation,
		// Only a shell this computer lists starts; an unknown or missing one falls back to the default.
		shell:
			operation.action === "create" && operation.shell
				? detectShells().find(shell => shell.path === operation.shell)
				: undefined,
	});
}

export function disposeTerminals(owner: string): void {
	void stockHelperRequest("terminal.dispose", { owner }).catch(() => {});
}
