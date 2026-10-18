/**
 * ai-memory's state (src/shared/ai-memory.ts), mirrored from main: `load()` reads the snapshot and follows every
 * push. The renderer only shows it; main owns the switch, the wiring, the service and the data (`window.omp.aiMemory`).
 */

import { create } from "zustand";
import type { AiMemoryState } from "../../shared/ai-memory";
import { lastRead, rememberRead } from "../lib/last-read";

const LAST_KEY = "ai-memory";

interface AiMemoryStore {
	state: AiMemoryState | null;
	load: () => Promise<void>;
	reset: () => void;
}

let unsubscribe: (() => void) | null = null;

export const useAiMemoryStore = create<AiMemoryStore>()(set => ({
	// The last state this device saw (the page's frame and rows at once); the read below replaces it in place.
	state: lastRead<AiMemoryState>(undefined, LAST_KEY) ?? null,
	load: async () => {
		try {
			unsubscribe ??= window.omp.aiMemory.onState(state => {
				rememberRead(undefined, LAST_KEY, state);
				set({ state });
			});
			const state = await window.omp.aiMemory.getState();
			rememberRead(undefined, LAST_KEY, state);
			set({ state });
		} catch {
			// The views keep what they have; the next open reads again.
		}
	},
	reset: () => {
		unsubscribe?.();
		unsubscribe = null;
		set({ state: null });
	},
}));
