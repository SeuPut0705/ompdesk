/**
 * Where a web page's UI takes over a `window.omp` call that has no native answer on a phone (design §2.4,
 * ipc-policy `mode: "web"`): the action sheets (view on the phone / open on the computer), the host folder and
 * file browser, the in-app editor, the restart and quit confirmation. The shim (shim.ts) calls a hook when one
 * is registered and otherwise falls back to a plain browser behavior (a download, `window.open`, `prompt`,
 * `confirm`, a file input). Sheets register themselves with `registerWebHostHooks` when they mount.
 *
 * `HostActions` is the other direction: the calls that act on the computer itself ("Open on computer",
 * "Show on computer"), which a sheet's button runs; the host refuses them for a device without
 * `desktop-control`.
 */
import type { IpcNotifyKind, IpcOpenPathResult } from "../../shared/ipc-types";

export interface FileFilter {
	name: string;
	extensions: string[];
}

export interface OpenDialogOptions {
	directory?: boolean;
	title?: string;
	buttonLabel?: string;
}

export interface WebHostHooks {
	/** An external link: open on the phone, or on the computer. */
	openExternal(url: string): Promise<void>;
	/** A file the agent named: view on the phone (Files viewer, download, share) or open on the computer. */
	openPath(path: string, tabId: string | undefined, host: HostActions): Promise<IpcOpenPathResult>;
	/** "Show in Finder": go to the file in the Files panel, or show it on the computer. */
	revealPath(path: string, tabId: string | undefined, host: HostActions): Promise<IpcOpenPathResult>;
	/** A host path to save to (the in-app folder browser); null = cancelled. */
	showSaveDialog(defaultPath: string | undefined, filters: FileFilter[] | undefined): Promise<string | null>;
	/** Save an image: on the phone or in a host folder. */
	saveImage(defaultName: string, mimeType: string, base64: string): Promise<{ saved: boolean; error?: string }>;
	/** Host paths picked in the in-app browser, or phone files uploaded; null = cancelled. */
	showOpenDialog(filters: FileFilter[] | undefined, options: OpenDialogOptions | undefined): Promise<string[] | null>;
	/** The project folder a new session starts in (the in-app host folder browser). */
	selectProject(): Promise<string | null>;
	/** The full-screen editor for the composer's "edit in $EDITOR". */
	openEditor(content: string, host: HostActions): Promise<EditorResult>;
	/** Restart or quit, after a confirmation that counts the running turns; false = cancelled. */
	confirmQuit(): Promise<boolean>;
	/** Apply a downloaded update (restarts the host and the link), after a confirmation; false = cancelled. */
	confirmUpdateApply(): Promise<boolean>;
	/** The page's own notification (visible page): a toast. Returns true when it showed one. */
	notify(title: string, body: string | undefined, tabId: string | undefined, kind: IpcNotifyKind | undefined): boolean;
	/** The run-progress bar. */
	progress(state: "working" | "waiting" | "idle"): void;
}

export interface EditorResult {
	ok: boolean;
	unavailable: boolean;
	text: string | null;
	error?: string;
}

/** Calls that act on the computer, bypassing the page-side overrides. */
export interface HostActions {
	openExternalOnComputer(url: string): Promise<void>;
	openPathOnComputer(path: string, tabId?: string): Promise<IpcOpenPathResult>;
	revealPathOnComputer(path: string, tabId?: string): Promise<IpcOpenPathResult>;
	/** The host's own save dialog / models.yml / $EDITOR flows. */
	editOnComputer(content: string): Promise<EditorResult>;
	openModelsConfigOnComputer(device?: string): Promise<{ path: string; opened: boolean }>;
}

let hooks: Partial<WebHostHooks> = {};

/** Register (or replace) hooks; returns a function that removes exactly these. */
export function registerWebHostHooks(next: Partial<WebHostHooks>): () => void {
	hooks = { ...hooks, ...next };
	return () => {
		const current: Partial<WebHostHooks> = { ...hooks };
		for (const key of Object.keys(next) as (keyof WebHostHooks)[]) {
			if (current[key] === next[key]) delete current[key];
		}
		hooks = current;
	};
}

export function webHostHooks(): Partial<WebHostHooks> {
	return hooks;
}
