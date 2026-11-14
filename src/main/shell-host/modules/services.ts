/**
 * `services.*` (PROTOCOL.md §15.7, batch SX3): the desktop services of `ipc.ts` that carried rules of their own, now
 * the shell's `services` module (`crates/shell/src/modules/services/`, rules in `services_core/`). The IPC handlers
 * stay in main (§15.4 rule 5) and call these. A window is named by its `BrowserWindow.id` (Node's ids until SX1).
 */
import type { PrivacyPane } from "../../../shared/agent-control";
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

export interface FileFilter {
	name: string;
	extensions: string[];
}

export interface OpenDialogOptions {
	directory?: boolean;
	title?: string;
	buttonLabel?: string;
}

export interface NoticeOptions {
	id: number;
	title: string;
	body: string;
	icon?: string;
	silent?: boolean;
}

export type NoticeResult = { shown: true } | { shown: false; error: string };

export interface ServicesSpec extends ModuleSpec {
	calls: {
		openOrReveal: { params: { path: string }; result: { outcome: "opened" | "revealed" } };
		saveImage: { params: { winId?: number; defaultName: string; mimeType: string }; result: SavedImage };
		confirm: {
			params: { winId?: number; options: ConfirmOptions; timeoutMs?: number };
			result: { response: number };
		};
		openExternal: { params: { url: unknown }; result: Record<string, never> };
		revealPath: { params: { path: string }; result: Record<string, never> };
		trashPath: { params: { path: string }; result: Record<string, never> };
		readClipboard: { params: Record<string, never>; result: { text: string } };
		writeClipboard: { params: { text: string }; result: Record<string, never> };
		openDialog: {
			params: { winId?: number; filters?: FileFilter[]; options?: OpenDialogOptions };
			result: string[] | null;
		};
		saveDialog: {
			params: { winId?: number; defaultPath?: string; filters?: FileFilter[] };
			result: string | null;
		};
		showNotice: { params: NoticeOptions; result: NoticeResult };
		closeNotice: { params: { id: number }; result: Record<string, never> };
		openPrivacyPane: { params: { pane: PrivacyPane }; result: Record<string, never> };
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
	openExternal(url: unknown): Promise<void>;
	/** Runtime must resolve and authorize the local path first; raw host-tab paths are not accepted here. */
	revealPath(path: string): Promise<void>;
	/** Only a path already authorized by the core's workspace mutation. */
	trashPath(path: string): Promise<void>;
	readClipboard(): Promise<string>;
	writeClipboard(text: string): Promise<void>;
	openDialog(winId: number | undefined, filters?: FileFilter[], options?: OpenDialogOptions): Promise<string[] | null>;
	saveDialog(winId: number | undefined, defaultPath?: string, filters?: FileFilter[]): Promise<string | null>;
	showNotice(options: NoticeOptions): Promise<NoticeResult>;
	closeNotice(id: number): Promise<void>;
	openPrivacyPane(pane: PrivacyPane): Promise<void>;
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
		openExternal: async url => {
			await client.call("openExternal", { url });
		},
		revealPath: async path => {
			await client.call("revealPath", { path });
		},
		trashPath: async path => {
			await client.call("trashPath", { path });
		},
		readClipboard: async () => (await client.call("readClipboard", {})).text,
		writeClipboard: async text => {
			await client.call("writeClipboard", { text });
		},
		openDialog: (winId, filters, options) => client.call("openDialog", { winId, filters, options }),
		saveDialog: (winId, defaultPath, filters) => client.call("saveDialog", { winId, defaultPath, filters }),
		showNotice: options => client.call("showNotice", options),
		closeNotice: async id => {
			await client.call("closeNotice", { id });
		},
		openPrivacyPane: async pane => {
			await client.call("openPrivacyPane", { pane });
		},
	};
}

export const desktopServices = servicesClient();
