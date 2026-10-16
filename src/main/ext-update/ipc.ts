import { IPC_COMMANDS } from "../../shared/ipc-types";
import type { ExtensionUpdater } from "./updater";

/** IPC: a snapshot and "Update now" by row key (or all). No handler takes a command, a path or a version. */
export interface ExtensionUpdateIpcTarget {
	handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export function registerExtensionUpdateIpc(
	ipc: ExtensionUpdateIpcTarget,
	updater: Pick<ExtensionUpdater, "state" | "updateNow" | "rescan">,
): void {
	ipc.handle(IPC_COMMANDS.EXTENSION_UPDATE_GET_STATE, () => {
		// Settings opened: look for what a plugin install or an MCP edit added since; the answer arrives as a push.
		void updater.rescan().catch(() => undefined);
		return updater.state();
	});
	ipc.handle(IPC_COMMANDS.EXTENSION_UPDATE_NOW, (_event, key) => {
		if (key === undefined || key === null) {
			void updater.updateNow().catch(() => undefined);
			return;
		}
		// Only a row of the current state is a handle; anything else (a path, a command) never reaches the updater.
		if (typeof key !== "string" || !updater.state().rows.some(row => row.key === key)) {
			throw new Error(`Unknown extension: ${String(key)}`);
		}
		// Runs in the background; progress arrives as EXTENSION_UPDATE_STATE pushes.
		void updater.updateNow(key).catch(() => undefined);
	});
}
