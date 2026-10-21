import { create } from "zustand";

/** The work board's sections, in the order it lists them. */
export type WorkBoardSectionId =
	| "autopilot"
	| "cycles"
	| "ship"
	| "followups"
	| "backlog"
	| "waiting"
	| "check"
	| "review"
	| "turn"
	| "running"
	| "opened"
	| "todos"
	| "goal"
	| "current";

const PREF = "workBoardCollapsed";

interface WorkBoardStore {
	/** Sections the user folded to their header; kept across launches and shared by every pane. */
	collapsed: Readonly<Partial<Record<WorkBoardSectionId, true>>>;
	hydrated: boolean;
	toggle: (id: WorkBoardSectionId) => void;
	/** Read the saved folds once; a fold made before the read lands wins. */
	hydrate: () => Promise<void>;
	reset: () => void;
}

export const useWorkBoardStore = create<WorkBoardStore>()((set, get) => ({
	collapsed: {},
	hydrated: false,
	toggle: id => {
		const { [id]: was, ...rest } = get().collapsed;
		const collapsed = was ? rest : { ...rest, [id]: true as const };
		set({ collapsed, hydrated: true });
		void window.omp?.prefs?.set?.(PREF, collapsed)?.catch(() => {});
	},
	hydrate: async () => {
		if (get().hydrated) return;
		set({ hydrated: true });
		try {
			const saved = await window.omp?.prefs?.get?.(PREF);
			if (!saved || typeof saved !== "object") return;
			const known: WorkBoardSectionId[] = [
				"autopilot",
				"cycles",
				"ship",
				"followups",
				"backlog",
				"waiting",
				"check",
				"review",
				"turn",
				"running",
				"opened",
				"todos",
				"goal",
				"current",
			];
			const collapsed = Object.fromEntries(
				known.filter(id => (saved as Record<string, unknown>)[id] === true).map(id => [id, true as const]),
			);
			set(state => ({ collapsed: { ...collapsed, ...state.collapsed } }));
		} catch {
			// Unfolded is the safe default.
		}
	},
	reset: () => set({ collapsed: {}, hydrated: false }),
}));
