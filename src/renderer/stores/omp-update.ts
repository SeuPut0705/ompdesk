/**
 * omp's automatic update (src/shared/omp-update.ts), mirrored from main:
 * `load()` reads it once and follows every push. The renderer only shows it
 * and may ask for "Update now"; main decides when and what to install.
 */

import { create } from "zustand";
import type { OmpUpdateState } from "../../shared/omp-update";
import { translate } from "../lib/i18n";
import { toastError } from "./toast";

interface OmpUpdateStore {
	state: OmpUpdateState | null;
	loading: boolean;
	load: () => Promise<void>;
	/** `load()` unless a state is already here or a read is in flight. */
	ensureLoaded: () => void;
	updateNow: () => Promise<void>;
	reset: () => void;
}

let unsubscribe: (() => void) | null = null;

export const useOmpUpdateStore = create<OmpUpdateStore>()((set, get) => ({
	state: null,
	loading: false,
	load: async () => {
		set({ loading: true });
		try {
			unsubscribe ??= window.omp.ompUpdate.onState(state => set({ state }));
			set({ state: await window.omp.ompUpdate.getState() });
		} catch {
			// The row stays on its checking text; the next open reads again.
		} finally {
			set({ loading: false });
		}
	},
	ensureLoaded: () => {
		const { state, loading, load } = get();
		if (state === null && !loading) void load();
	},
	updateNow: async () => {
		try {
			await window.omp.ompUpdate.now();
		} catch (error) {
			toastError({ title: translate("ompUpdate.nowFailed"), error });
		}
	},
	reset: () => {
		unsubscribe?.();
		unsubscribe = null;
		set({ state: null, loading: false });
	},
}));
