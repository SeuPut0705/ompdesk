/**
 * Setup IPC: a state snapshot, a retry by item id, a cancel. No handler takes
 * a command, a path or a plan from the renderer; an id outside SETUP_ITEMS is
 * refused before anything runs.
 */
import { IPC_COMMANDS } from "../../shared/ipc-types";
import { isSetupItemId, type SetupState } from "../../shared/setup";

export interface SetupIpcTarget {
	handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

export interface SetupIpcService {
	state(): SetupState;
	retry(item: unknown): Promise<void>;
	cancel(): boolean;
}

export function registerSetupIpc(ipc: SetupIpcTarget, service: SetupIpcService): void {
	ipc.handle(IPC_COMMANDS.SETUP_GET_STATE, () => service.state());
	ipc.handle(IPC_COMMANDS.SETUP_RETRY, (_event, item) => {
		if (!isSetupItemId(item)) throw new Error(`Unknown setup item: ${String(item)}`);
		// The retry runs in the background; its progress arrives as SETUP_STATE pushes.
		void service.retry(item).catch(() => undefined);
	});
	ipc.handle(IPC_COMMANDS.SETUP_CANCEL, () => service.cancel());
}
