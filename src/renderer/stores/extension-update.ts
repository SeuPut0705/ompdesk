/**
 * The extensions' automatic updates (src/shared/extension-update.ts), mirrored from main: `load()` reads the
 * snapshot (main also rescans the marketplaces, plugins, skills and MCP servers then) and follows every push.
 * The renderer only shows it and may ask for "Update now" by row key; main decides what runs and how.
 */

import { create } from "zustand";
import type { ExtensionUpdateState } from "../../shared/extension-update";
import { translate } from "../lib/i18n";
import { toastError } from "./toast";

interface ExtensionUpdateStore {
	state: ExtensionUpdateState | null;
	load: () => Promise<void>;
	/** One row, or every updatable row when `key` is omitted. */
	updateNow: (key?: string) => Promise<void>;
	reset: () => void;
}

let unsubscribe: (() => void) | null = null;

export const useExtensionUpdateStore = create<ExtensionUpdateStore>()(set => ({
	state: null,
	load: async () => {
		try {
			unsubscribe ??= window.omp.extensionUpdate.onState(state => set({ state }));
			set({ state: await window.omp.extensionUpdate.getState() });
		} catch {
			// The section keeps what it has; the next open reads again.
		}
	},
	updateNow: async key => {
		try {
			await window.omp.extensionUpdate.now(key);
		} catch (error) {
			toastError({ title: translate("extensionUpdate.nowFailed"), error });
		}
	},
	reset: () => {
		unsubscribe?.();
		unsubscribe = null;
		set({ state: null });
	},
}));
