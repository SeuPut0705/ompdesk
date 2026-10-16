/**
 * Calls only a paired web device makes, answered by the web server itself rather than a handler Electron's
 * windows share (src/main/web/host-actions.ts). They stand in for what a desktop does with a native dialog
 * or the shell: browse the host's disk, save to it, open something on its screen, hand a file to the page
 * over `/blob/<token>`. The page reaches them as `inv` frames like any channel; each needs its permission.
 */
import type { IpcErrorCode } from "./ipc-error-codes";
import type { IpcOpenPathResult } from "./ipc-types";

export const WEB_HOST_CHANNELS = {
	/** `WebHostListRequest` → `WebHostListing`: one level of the host's disk. */
	LIST_DIRS: "web:host.listDirs",
	/** `WebHostSaveRequest` → `WebHostSaveResult`: write a file on the host. */
	SAVE: "web:host.save",
	/** `{path}` → `IpcOpenPathResult`: open a file with the host's own handler (launcher types are revealed instead). */
	OPEN: "web:host.open",
	/** `{path}` → `IpcOpenPathResult`: show a file in the host's Finder / Explorer. */
	REVEAL: "web:host.reveal",
	/** `{url}`: open a web page or mail draft in the host's browser. */
	OPEN_EXTERNAL: "web:host.openExternal",
	/** `WebBlobOpenRequest` → `WebBlobOpenResult`: a URL the page fetches (with Range) or downloads. */
	BLOB_OPEN: "web:blob.open",
	/** The blob URL (or `{url}`): the page is done with it. */
	BLOB_RELEASE: "web:blob.release",
	/** → `WebModelsText`: the agent's models.yml as text for the in-app editor (a skeleton when it does not exist yet). */
	MODELS_CONFIG_READ: "web:models.config.read",
	/** `WebModelsWriteRequest` → `WebModelsWriteResult`: check the text with the models.yml parser and save it. */
	MODELS_CONFIG_WRITE: "web:models.config.write",
} as const;

export type WebHostChannel = (typeof WEB_HOST_CHANNELS)[keyof typeof WEB_HOST_CHANNELS];

/** The most entries one `LIST_DIRS` answer carries. */
export const WEB_HOST_LIST_MAX_ENTRIES = 500;

export interface WebHostListRequest {
	/** The directory (absolute; the host's home when omitted). */
	path?: string;
	/** Only names containing this (case-insensitive). */
	query?: string;
	/** Also list files, not only folders. */
	files?: boolean;
}

export interface WebHostEntry {
	name: string;
	path: string;
	directory: boolean;
	/** Bytes of a file; null for a folder. */
	size: number | null;
}

export interface WebHostListing {
	/** The directory listed. */
	path: string;
	/** Its parent; null at a filesystem root. */
	parent: string | null;
	/** The host user's home, the browser's starting point and shortcut. */
	home: string;
	entries: WebHostEntry[];
	truncated: boolean;
}

export interface WebHostSaveRequest {
	/** The folder to write into (absolute, an existing directory). */
	dir: string;
	/** The file name: one path segment. */
	name: string;
	/** The bytes, base64 (small files; a frame is at most 1 MiB). */
	data?: string;
	/** A file this device uploaded (`POST /upload` answered this path): copied instead of `data`. */
	uploadPath?: string;
	/** Replace an existing file; without it a name that exists is refused (`exists`). */
	overwrite?: boolean;
}

export type WebHostSaveResult = { ok: true; path: string } | { ok: false; error: string; code?: IpcErrorCode };

export type WebHostOpenResult = IpcOpenPathResult;

export interface WebBlobOpenRequest {
	/** Absolute, `~/…`, or relative to the tab's folder. */
	path: string;
	tabId?: string;
	/** Serve as an attachment (the page's download / "save to phone"). */
	download?: boolean;
}

export type WebBlobOpenResult =
	| { ok: true; url: string; mime: string; size: number; name: string }
	| { ok: false; error: string; code?: IpcErrorCode };

export interface WebModelsText {
	/** The file on the host (shown, and what "Edit on computer" opens). */
	path: string;
	text: string;
	/** False while the file does not exist: `text` is a skeleton and saving creates it. */
	exists: boolean;
	/** Identifies the file as read; a save refuses when the file changed since. */
	stamp: string;
}

export interface WebModelsWriteRequest {
	text: string;
	stamp: string;
}

export type WebModelsWriteResult = { ok: true; stamp: string } | { ok: false; error: string; code?: IpcErrorCode };
