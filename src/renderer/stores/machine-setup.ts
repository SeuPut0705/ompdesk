/**
 * This machine's automatic setup (src/shared/setup.ts), mirrored from main:
 * `load()` reads it once and subscribes to every pushed change. The renderer
 * only shows it and may ask for a retry or a cancel; main installs on its own.
 */

import { create } from "zustand";
import type { SetupItemId, SetupState } from "../../shared/setup";
import { translate } from "../lib/i18n";
import { toastError } from "./toast";

interface MachineSetupStore {
	state: SetupState | null;
	/** The last `getState` failed (before any state arrived). */
	loadError: unknown;
	loading: boolean;
	/**
	 * omp was missing or being installed at some point since the last ready
	 * session: the install step stays up (as "Starting omp…") until main's
	 * restart brings the session back, instead of flashing the empty hero.
	 */
	installSeen: boolean;
	load: () => Promise<void>;
	/** `load()` unless a state is already here or a read is in flight. */
	ensureLoaded: () => void;
	retry: (item: SetupItemId) => Promise<void>;
	cancel: () => Promise<void>;
	clearInstallSeen: () => void;
	reset: () => void;
}

let unsubscribe: (() => void) | null = null;

export const useMachineSetupStore = create<MachineSetupStore>()((set, get) => {
	const apply = (state: SetupState) =>
		set({
			state,
			loadError: null,
			installSeen: get().installSeen || !state.ompReady || state.requiredRunning,
		});
	return {
		state: null,
		loadError: null,
		loading: false,
		installSeen: false,
		load: async () => {
			set({ loading: true });
			try {
				unsubscribe ??= window.omp.setup.onState(apply);
				apply(await window.omp.setup.getState());
			} catch (error) {
				set({ loadError: error });
			} finally {
				set({ loading: false });
			}
		},
		ensureLoaded: () => {
			const { state, loading, load } = get();
			if (state === null && !loading) void load();
		},
		retry: async item => {
			try {
				await window.omp.setup.retry(item);
			} catch (error) {
				toastError({ title: translate("machineSetup.retryFailed"), error });
			}
		},
		cancel: async () => {
			try {
				await window.omp.setup.cancel();
			} catch (error) {
				toastError({ title: translate("machineSetup.cancelFailed"), error });
			}
		},
		clearInstallSeen: () => set({ installSeen: false }),
		reset: () => {
			unsubscribe?.();
			unsubscribe = null;
			set({ state: null, loadError: null, loading: false, installSeen: false });
		},
	};
});
