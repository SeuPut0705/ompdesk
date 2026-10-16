/**
 * The tool CLIs' automatic updates (src/shared/cli-update.ts), mirrored from main: `load()` reads the
 * snapshot (main also looks for newly installed tools then) and follows every push. The renderer only
 * shows it and may ask for "Update now" by tool id; main decides what runs and how.
 */

import { create } from "zustand";
import type { CliToolId, CliUpdateState } from "../../shared/cli-update";
import { translate } from "../lib/i18n";
import { toastError } from "./toast";

interface CliUpdateStore {
	state: CliUpdateState | null;
	load: () => Promise<void>;
	/** One tool, or every listed tool when `id` is omitted. */
	updateNow: (id?: CliToolId) => Promise<void>;
	reset: () => void;
}

let unsubscribe: (() => void) | null = null;

export const useCliUpdateStore = create<CliUpdateStore>()(set => ({
	state: null,
	load: async () => {
		try {
			unsubscribe ??= window.omp.cliUpdate.onState(state => set({ state }));
			set({ state: await window.omp.cliUpdate.getState() });
		} catch {
			// The section keeps what it has; the next open reads again.
		}
	},
	updateNow: async id => {
		try {
			await window.omp.cliUpdate.now(id);
		} catch (error) {
			toastError({ title: translate("cliUpdate.nowFailed"), error });
		}
	},
	reset: () => {
		unsubscribe?.();
		unsubscribe = null;
		set({ state: null });
	},
}));
