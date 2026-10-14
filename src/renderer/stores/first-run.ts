import { create } from "zustand";

/**
 * Inline first-run setup in the empty main area: `connect` (pick a provider,
 * sign in or paste a key) → `model` (choose the default model) → `github`
 * (optional GitHub sign-in) → `idle` (ready to prompt, or dismissed with
 * "Set up later").
 */
export type FirstRunPhase = "idle" | "connect" | "model" | "github";

/** Prefs key holding the step reached, so a relaunch resumes there (cleared at `idle`). */
export const FIRST_RUN_STEP_PREF = "firstRunStep";

/** A step a relaunch may resume: only those past `connect`, which the gate opens on its own. */
export function isResumableFirstRunStep(value: unknown): value is "model" | "github" {
	return value === "model" || value === "github";
}

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
	setPhase: (phase, connectedProvider) => {
		if (phase !== get().phase) {
			// Resume is a convenience: a failed write only means the next launch starts over.
			void window.omp.prefs.set(FIRST_RUN_STEP_PREF, phase === "idle" ? undefined : phase).catch(() => {});
		}
		set({ phase, connectedProvider: connectedProvider === undefined ? get().connectedProvider : connectedProvider });
	},
	reset: () => set({ phase: "idle", connectedProvider: null }),
}));
