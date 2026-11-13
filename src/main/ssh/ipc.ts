import {
	SSH_TOOLS_AGENT,
	SSH_TOOLS_COMMAND,
	SSH_TOOLS_PROMPT,
	SSH_TOOLS_PROMPTS,
	SSH_TOOLS_STATE,
} from "../../shared/ssh-tools";
import type { IpcRegistry } from "../web/ipc-registry";
import { SshTools } from "./service";

export interface SshToolsIpcDeps {
	userData: string;
	/** A push to every app window (not a paired page: SSH tools are this computer's Settings). */
	sendToWindows(channel: string, data: unknown): void;
	/** Runs `dispose` when the app quits. */
	onQuit(dispose: () => void): void;
}

/** Settings › SSH tools for every window; saved forwards start again right away (C151 restore). */
export function registerSshToolsIpc(ipc: IpcRegistry, deps: SshToolsIpcDeps): void {
	const tools = new SshTools({
		userData: deps.userData,
		broadcast: (kind, data) => deps.sendToWindows(kind === "state" ? SSH_TOOLS_STATE : SSH_TOOLS_PROMPT, data),
	});
	ipc.handle(SSH_TOOLS_COMMAND, (_caller, request: unknown) => tools.command(request));
	ipc.handle(SSH_TOOLS_AGENT, () => tools.agent());
	// A window that opens (or reloads) while a question waits still sees it.
	ipc.handle(SSH_TOOLS_PROMPTS, () => tools.prompts());
	deps.onQuit(() => tools.dispose());
	void tools.start();
}
