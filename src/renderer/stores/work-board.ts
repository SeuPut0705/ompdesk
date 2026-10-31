import { create } from "zustand";

/** The work board's sections, in the order it lists them. */
export type WorkBoardSectionId =
	| "needs"
	| "autopilot"
	| "cycles"
	| "ship"
	| "followups"
	| "duties"
	| "tasks"
	| "library"
	| "review"
	| "now"
	| "plan"
	| "current";

const PREF = "workBoardCollapsed";

const SECTION_IDS: readonly WorkBoardSectionId[] = [
	"needs",
	"autopilot",
	"cycles",
	"ship",
	"followups",
	"duties",
	"tasks",
	"library",
	"review",
	"now",
	"plan",
	"current",
];

/**
 * The folds a saved pref holds that today's board still has. An id of the board before the four zones (23 Oct 2026:
 * waiting, check, turn, running, opened, todos, goal) is dropped, not mapped to the zone that took its rows: one fold
 * of a single old section would fold a whole zone (a folded failed check, Needs you; a folded child list, Now), and
 * unfolded is the safe default. Read once when the pref loads; the next fold the person makes writes today's ids back.
 */
export function migrateCollapsed(saved: unknown): Partial<Record<WorkBoardSectionId, true>> {
	if (!saved || typeof saved !== "object") return {};
	const folded: Partial<Record<WorkBoardSectionId, true>> = {};
	for (const [id, value] of Object.entries(saved)) {
		const known = SECTION_IDS.find(section => section === id);
		if (known && value === true) folded[known] = true;
	}
	return folded;
}

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
			const collapsed = migrateCollapsed(saved);
			set(state => ({ collapsed: { ...collapsed, ...state.collapsed } }));
		} catch {
			// Unfolded is the safe default.
		}
	},
	reset: () => set({ collapsed: {}, hydrated: false }),
}));
