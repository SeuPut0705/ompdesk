/**
 * Setup IPC: a state snapshot, a retry by item id, a cancel, and the Git item's Mandatory ASLR override. No
 * handler takes a command, a path or a plan from the renderer; an id outside SETUP_ITEMS or an action other than
 * fix/undo is refused before anything runs.
 */
import { IPC_COMMANDS } from "../../shared/ipc-types";
import {
	type GitAslrAction,
	type GitAslrResult,
	isGitAslrAction,
	isSetupItemId,
	type SetupState,
} from "../../shared/setup";
import type { IpcRegistry } from "../web/ipc-registry";

export interface SetupIpcService {
	state(): SetupState;
	retry(item: unknown): Promise<void>;
	cancel(): boolean;
	gitAslr(action: GitAslrAction): Promise<GitAslrResult>;
}

export function registerSetupIpc(ipc: IpcRegistry, service: SetupIpcService): void {
	ipc.handle(IPC_COMMANDS.SETUP_GET_STATE, () => service.state());
	ipc.handle(IPC_COMMANDS.SETUP_RETRY, (_caller, item: unknown) => {
		if (!isSetupItemId(item)) throw new Error(`Unknown setup item: ${String(item)}`);
		// The retry runs in the background; its progress arrives as SETUP_STATE pushes.
		void service.retry(item).catch(() => undefined);
	});
	ipc.handle(IPC_COMMANDS.SETUP_CANCEL, () => service.cancel());
	ipc.handle(IPC_COMMANDS.SETUP_GIT_ASLR, (_caller, action: unknown) => {
		if (!isGitAslrAction(action)) throw new Error(`Unknown Git ASLR action: ${String(action)}`);
		return service.gitAslr(action);
	});
}
