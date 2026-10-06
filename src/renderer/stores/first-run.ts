import { create } from "zustand";

/**
 * Inline first-run setup in the empty main area: `connect` (pick a provider,
 * sign in or paste a key) → `model` (choose the default model) → `idle`
 * (ready to prompt, or dismissed with "Set up later").
 */
export type FirstRunPhase = "idle" | "connect" | "model";

interface FirstRunState {
	phase: FirstRunPhase;
	/** Provider connected in this setup; its models are offered first. */
	connectedProvider: string | null;
	setPhase: (phase: FirstRunPhase, connectedProvider?: string | null) => void;
	reset: () => void;
}

export const useFirstRunStore = create<FirstRunState>()((set, get) => ({
	phase: "idle",
	connectedProvider: null,
	setPhase: (phase, connectedProvider) =>
		set({ phase, connectedProvider: connectedProvider === undefined ? get().connectedProvider : connectedProvider }),
	reset: () => set({ phase: "idle", connectedProvider: null }),
}));
