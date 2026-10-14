import { create } from "zustand";

/**
 * Getting-started checklist at the sidebar foot. Each step completes from
 * real app state (StarterGuide watches it) and stays done: the list only ever
 * grows, merged with what prefs already hold, so a slow load never moves a
 * step backwards. A step's tour spotlights the real control (StarterTour).
 * Saved in prefs (main), not localStorage, so every window agrees.
 */
export const STARTER_STEPS = ["model", "prompt", "project", "split", "panel"] as const;
export type StarterStep = (typeof STARTER_STEPS)[number];

export const STARTER_GUIDE_PREF = "starterGuide";

export interface SavedStarterGuide {
	done: StarterStep[];
	dismissed: boolean;
}

function isStarterStep(value: unknown): value is StarterStep {
	return (STARTER_STEPS as readonly unknown[]).includes(value);
}

/** Read the saved guide; anything malformed counts as a fresh guide. */
export function parseStarterGuide(value: unknown): SavedStarterGuide {
	if (typeof value !== "object" || value === null) return { done: [], dismissed: false };
	const record = value as Record<string, unknown>;
	const done = Array.isArray(record.done) ? record.done.filter(isStarterStep) : [];
	return { done: STARTER_STEPS.filter(step => done.includes(step)), dismissed: record.dismissed === true };
}

interface StarterGuideState extends SavedStarterGuide {
	loaded: boolean;
	/** The step whose spotlight tour is on screen. */
	tour: StarterStep | null;
	load: () => Promise<void>;
	complete: (steps: readonly StarterStep[]) => void;
	dismiss: () => void;
	startTour: (step: StarterStep) => void;
	endTour: () => void;
	reset: () => void;
}

const INITIAL = { loaded: false, done: [], dismissed: false, tour: null } as const;

function persist(state: SavedStarterGuide): void {
	// A failed write only means the next launch re-derives the steps from state again.
	void window.omp.prefs.set(STARTER_GUIDE_PREF, { done: state.done, dismissed: state.dismissed }).catch(() => {});
}

export const useStarterGuideStore = create<StarterGuideState>()((set, get) => ({
	...INITIAL,
	done: [],
	load: async () => {
		let saved: SavedStarterGuide;
		try {
			saved = parseStarterGuide(await window.omp.prefs.get(STARTER_GUIDE_PREF));
		} catch {
			saved = { done: [], dismissed: false };
		}
		const current = get();
		const done = STARTER_STEPS.filter(step => saved.done.includes(step) || current.done.includes(step));
		const dismissed = saved.dismissed || current.dismissed;
		set({ loaded: true, done, dismissed });
		if (done.length !== saved.done.length || dismissed !== saved.dismissed) persist({ done, dismissed });
	},
	complete: steps => {
		const current = get();
		const added = steps.filter(step => !current.done.includes(step));
		if (added.length === 0) return;
		const done = STARTER_STEPS.filter(step => current.done.includes(step) || added.includes(step));
		set({ done, tour: current.tour && added.includes(current.tour) ? null : current.tour });
		// Before load settles, load() merges and writes the union itself.
		if (current.loaded) persist({ done, dismissed: current.dismissed });
	},
	dismiss: () => {
		set({ dismissed: true, tour: null });
		persist({ done: get().done, dismissed: true });
	},
	startTour: step => set({ tour: step }),
	endTour: () => set({ tour: null }),
	reset: () => set({ ...INITIAL, done: [] }),
}));
