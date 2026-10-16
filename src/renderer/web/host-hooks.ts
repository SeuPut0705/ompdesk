/**
 * Where a web page's UI takes over a `window.omp` call that has no native answer on a phone (design §2.4,
 * ipc-policy `mode: "web"`): the action sheets (view on the phone / open on the computer), the host folder
 * and file browser, the in-app editors, the restart and quit confirmation. The shim (shim.ts) calls a hook
 * when one is registered and otherwise falls back to a plain browser behavior (a download, `window.open`,
 * `prompt`, `confirm`, a file input). The sheets (host-ui/) register themselves with `registerWebHostHooks`
 * when they mount.
 *
 * `HostActions` is the other direction: the calls a sheet's button runs, some on the computer itself ("Open
 * on computer", "Show on computer"; the host refuses those for a device without `desktop-control`), some on
 * the computer's disk (browse, save, models.yml), some on this device (download, pick a file).
 */
import type { IpcNotifyKind, IpcOpenPathResult } from "../../shared/ipc-types";
import type {
	WebHostListing,
	WebHostListRequest,
	WebHostSaveRequest,
	WebHostSaveResult,
	WebModelsText,
	WebModelsWriteRequest,
	WebModelsWriteResult,
} from "../../shared/web-host";

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
	showSaveDialog(
		defaultPath: string | undefined,
		filters: FileFilter[] | undefined,
		host: HostActions,
	): Promise<string | null>;
	/** Save an image: on the phone or in a host folder. */
	saveImage(
		defaultName: string,
		mimeType: string,
		base64: string,
		host: HostActions,
	): Promise<{ saved: boolean; error?: string }>;
	/** Host paths picked in the in-app browser, or phone files uploaded; null = cancelled. */
	showOpenDialog(
		filters: FileFilter[] | undefined,
		options: OpenDialogOptions | undefined,
		host: HostActions,
	): Promise<string[] | null>;
	/** The project folder a new session starts in (the in-app host folder browser). */
	selectProject(host: HostActions): Promise<string | null>;
	/** The full-screen editor for the composer's "edit in $EDITOR". */
	openEditor(content: string, host: HostActions): Promise<EditorResult>;
	/** The in-app editor of the agent's models.yml (Settings › "Edit config"); `opened` false = closed unsaved. */
	openModelsConfig(host: HostActions): Promise<{ path: string; opened: boolean }>;
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

/** What a sheet's button runs, bypassing the page-side overrides. */
export interface HostActions {
	/** On the computer's screen (`desktop-control`). */
	openExternalOnComputer(url: string): Promise<void>;
	openPathOnComputer(path: string, tabId?: string): Promise<IpcOpenPathResult>;
	revealPathOnComputer(path: string, tabId?: string): Promise<IpcOpenPathResult>;
	/** The host's own $EDITOR round trip. */
	editOnComputer(content: string): Promise<EditorResult>;
	openModelsConfigOnComputer(device?: string): Promise<{ path: string; opened: boolean }>;
	/** The computer's disk (`workspace`): one level of a folder, and a file written into one. */
	listDirs(request: WebHostListRequest): Promise<WebHostListing>;
	saveToHost(request: WebHostSaveRequest): Promise<WebHostSaveResult>;
	/** The agent's models.yml as text, and the checked save (`settings-write`). */
	modelsConfigRead(): Promise<WebModelsText>;
	modelsConfigWrite(request: WebModelsWriteRequest): Promise<WebModelsWriteResult>;
	/** A computer file handed to this device: the share sheet or a download. */
	downloadToPhone(path: string, tabId?: string): Promise<IpcOpenPathResult>;
	/** Bytes this page holds (an image) handed to this device: the share sheet or a download. */
	saveBytesToPhone(name: string, mime: string, base64: string): Promise<{ saved: boolean; error?: string }>;
	/** Files picked on this device and uploaded, as the host paths they got; null = none. */
	pickPhoneFiles(filters: FileFilter[] | undefined): Promise<string[] | null>;
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
