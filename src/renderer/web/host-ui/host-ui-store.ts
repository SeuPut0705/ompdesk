import { create } from "zustand";
import type { IpcOpenPathResult } from "../../../shared/ipc-types";
import type { EditorResult, FileFilter, HostActions } from "../host-hooks";

/** A file the agent named, to view on the phone or act on at the computer. */
interface PathPrompt {
	path: string;
	tabId?: string;
	host: HostActions;
	resolve: (result: IpcOpenPathResult) => void;
}

/**
 * One thing the host's UI asks of the person on a web page: an action sheet, the host folder browser, an
 * editor, a confirmation. The shim's hooks (host-hooks.ts) turn each `window.omp` call into a prompt and wait
 * for its `resolve`; `WebHostUi` shows the first of the queue (never two sheets at once) and settles it.
 */
export type HostPrompt =
	| ({ kind: "openPath" } & PathPrompt)
	| ({ kind: "revealPath" } & PathPrompt)
	| {
			kind: "browse";
			mode: "folder" | "file" | "save";
			title?: string;
			defaultPath?: string;
			filters?: FileFilter[];
			host: HostActions;
			resolve: (paths: string[] | null) => void;
	  }
	| {
			kind: "saveImage";
			name: string;
			mime: string;
			base64: string;
			host: HostActions;
			resolve: (result: { saved: boolean; error?: string }) => void;
	  }
	| { kind: "editor"; content: string; host: HostActions; resolve: (result: EditorResult) => void }
	| { kind: "models"; host: HostActions; resolve: (result: { path: string; opened: boolean }) => void }
	| { kind: "quit"; resolve: (confirmed: boolean) => void }
	| { kind: "update"; resolve: (confirmed: boolean) => void };

interface HostUiStore {
	queue: HostPrompt[];
	push: (prompt: HostPrompt) => void;
	/** Drop the prompt in front (the sheet that showed it has resolved it). */
	shift: () => void;
	reset: () => void;
}

export const useHostUiStore = create<HostUiStore>()(set => ({
	queue: [],
	push: prompt => set(state => ({ queue: [...state.queue, prompt] })),
	shift: () => set(state => ({ queue: state.queue.slice(1) })),
	reset: () => set({ queue: [] }),
}));
