/**
 * Setup IPC: a state snapshot, a retry by item id, a cancel. No handler takes
 * a command, a path or a plan from the renderer; an id outside SETUP_ITEMS is
 * refused before anything runs.
 */
import { IPC_COMMANDS } from "../../shared/ipc-types";
import { isSetupItemId, type SetupState } from "../../shared/setup";
import type { IpcRegistry } from "../web/ipc-registry";

export interface SetupIpcService {
	state(): SetupState;
	retry(item: unknown): Promise<void>;
	cancel(): boolean;
}

export function registerSetupIpc(ipc: IpcRegistry, service: SetupIpcService): void {
	ipc.handle(IPC_COMMANDS.SETUP_GET_STATE, () => service.state());
	ipc.handle(IPC_COMMANDS.SETUP_RETRY, (_caller, item: unknown) => {
		if (!isSetupItemId(item)) throw new Error(`Unknown setup item: ${String(item)}`);
		// The retry runs in the background; its progress arrives as SETUP_STATE pushes.
		void service.retry(item).catch(() => undefined);
	});
	ipc.handle(IPC_COMMANDS.SETUP_CANCEL, () => service.cancel());
}
