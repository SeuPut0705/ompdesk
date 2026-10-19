import { create } from "zustand";

/**
 * Inline first-run setup in the empty main area: `connect` (pick a provider,
 * sign in or paste a key) → `idle` (ready to prompt, or dismissed with
 * "Set up later"). The default model is picked on its own when a provider
 * connects; `model` is the fallback when none can be picked or saving it fails.
 */
export type FirstRunPhase = "idle" | "connect" | "model";

/** Prefs key holding the step reached, so a relaunch resumes there (cleared at `idle`). */
export const FIRST_RUN_STEP_PREF = "firstRunStep";

/** A step a relaunch may resume: only those past `connect`, which the gate opens on its own. */
export function isResumableFirstRunStep(value: unknown): value is "model" {
	return value === "model";
}

interface FirstRunState {
	phase: FirstRunPhase;
	/** Provider connected in this setup; its models are offered first. */
	connectedProvider: string | null;
	/**
	 * The connect step was opened before omp could say whether a provider serves (right after machine setup
	 * installed it): the gate's check settles it, so the step neither moves on nor is saved before that.
	 */
	provisional: boolean;
	setPhase: (phase: FirstRunPhase, connectedProvider?: string | null) => void;
	/** Why the automatic default-model pick failed; the model step opens showing it. */
	modelError: string | null;
	setModelError: (message: string | null) => void;
	/** Open the connect step ahead of the gate's provider check (see `provisional`). */
	openProvisional: () => void;
	reset: () => void;
	/**
	 * The "Add custom endpoint" form is open on the connect step. Kept here, not in the step: the session pane
	 * is rebuilt once right after launch (its tab is keyed), and a step's own state would be lost with it.
	 */
	customForm: boolean;
	setCustomForm: (open: boolean) => void;
}

export const useFirstRunStore = create<FirstRunState>()((set, get) => ({
	phase: "idle",
	connectedProvider: null,
	provisional: false,
	customForm: false,
	modelError: null,
	setCustomForm: customForm => set({ customForm }),
	setModelError: modelError => set({ modelError }),
	setPhase: (phase, connectedProvider) => {
		if (phase !== get().phase || get().provisional) {
			// Resume is a convenience: a failed write only means the next launch starts over.
			void window.omp.prefs.set(FIRST_RUN_STEP_PREF, phase === "idle" ? undefined : phase).catch(() => {});
		}
		set({
			phase,
			provisional: false,
			connectedProvider: connectedProvider === undefined ? get().connectedProvider : connectedProvider,
			customForm: phase === "connect" ? get().customForm : false,
			modelError: phase === "model" ? get().modelError : null,
		});
	},
	openProvisional: () => {
		if (get().phase === "idle") set({ phase: "connect", provisional: true, connectedProvider: null });
	},
	reset: () =>
		set({ phase: "idle", provisional: false, connectedProvider: null, customForm: false, modelError: null }),
}));
