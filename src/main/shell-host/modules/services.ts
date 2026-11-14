/**
 * `services.*` (PROTOCOL.md §15.7, batch SX3): the desktop services of `ipc.ts` that carried rules of their own, now
 * the shell's `services` module (`crates/shell/src/modules/services/`, rules in `services_core/`). The IPC handlers
 * stay in main (§15.4 rule 5) and call these. A window is named by its `BrowserWindow.id` (Node's ids until SX1).
 */
import { type ModuleClient, type ModuleSpec, shellModule } from "./client";

export interface ConfirmOptions {
	type?: "none" | "info" | "warning" | "error" | "question";
	title?: string;
	message: string;
	detail?: string;
	buttons: string[];
	defaultId?: number;
	cancelId?: number;
}

export interface SavedImage {
	saved: boolean;
	/** Why the chosen file could not be written. */
	error?: string;
}

export interface ServicesSpec extends ModuleSpec {
	calls: {
		openOrReveal: { params: { path: string }; result: { outcome: "opened" | "revealed" } };
		saveImage: { params: { winId?: number; defaultName: string; mimeType: string }; result: SavedImage };
		confirm: {
			params: { winId?: number; options: ConfirmOptions; timeoutMs?: number };
			result: { response: number };
		};
	};
	posts: Record<string, never>;
	events: Record<string, never>;
	asks: Record<string, never>;
}

export interface DesktopServices {
	/** Opens a path in its default app, or reveals it: always for a launcher (it could run code), and when no app takes it. */
	openOrReveal(path: string): Promise<"opened" | "revealed">;
	/** A save panel for a picture (its name and type from the page), then its bytes written there. */
	saveImage(winId: number | undefined, defaultName: string, mimeType: string, data: Uint8Array): Promise<SavedImage>;
	/** A message box that closes itself and answers its `cancelId` once `timeoutMs` passed without a choice. */
	confirm(winId: number | undefined, options: ConfirmOptions, timeoutMs?: number): Promise<number>;
}

/** The module's client; a parity suite passes its own shell. */
export function servicesClient(
	client: ModuleClient<ServicesSpec> = shellModule<ServicesSpec>("services"),
): DesktopServices {
	return {
		openOrReveal: async path => (await client.call("openOrReveal", { path })).outcome,
		saveImage: async (winId, defaultName, mimeType, data) =>
			(await client.request("saveImage", { winId, defaultName, mimeType }, { bin: data })).result,
		confirm: async (winId, options, timeoutMs) =>
			(await client.call("confirm", { winId, options, ...(timeoutMs === undefined ? {} : { timeoutMs }) })).response,
	};
}

export const desktopServices = servicesClient();
