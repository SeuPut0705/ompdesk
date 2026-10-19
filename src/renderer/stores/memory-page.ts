/**
 * Settings › Memory's page state that outlives one section: the chosen project, the page another section wants
 * opened in Pages, the pages deleted from here (what Restore reads them back from), and `version`, which every write
 * bumps so each list on the page reads again. The data itself is `window.omp.aiMemory`, snapshot-cached by
 * `use-memory-read.ts`.
 */
import { create } from "zustand";
import type { AiMemoryDeleted, AiMemoryProjectRef } from "../../shared/ai-memory";
import { lastRead, rememberRead } from "../lib/last-read";

const DELETED_KEY = "memory-deleted";
const PROJECT_KEY = "memory-project";
const DELETED_LIMIT = 20;

export type MemoryPageTab = "overview" | "search" | "pages" | "handoffs" | "sessions" | "profile" | "maintenance";
export const MEMORY_PAGE_TABS: readonly MemoryPageTab[] = [
	"overview",
	"search",
	"pages",
	"handoffs",
	"sessions",
	"profile",
	"maintenance",
];

export interface MemoryPageTarget extends AiMemoryProjectRef {
	path: string;
}

interface MemoryPageStore {
	/** The project the page shows (null: not chosen; the page falls back to the one for the active session's folder). */
	project: AiMemoryProjectRef | null;
	setProject: (project: AiMemoryProjectRef | null) => void;
	/** A page another section asked Pages to open; Pages takes it once. */
	pending: MemoryPageTarget | null;
	/** Opens a page in Pages (selects its project too). Sections call `useMemoryPageStore.getState().openPage`; the shell moves to the Pages tab. */
	openPage: (target: MemoryPageTarget) => void;
	takePending: () => MemoryPageTarget | null;
	deleted: AiMemoryDeleted[];
	addDeleted: (item: AiMemoryDeleted) => void;
	removeDeleted: (item: Pick<AiMemoryDeleted, "workspace" | "project" | "path">) => void;
	/** Bumped by every write; reads depend on it. */
	version: number;
	bump: () => void;
	/** Bumped by `openPage`; the shell watches it to show Pages. */
	openRequest: number;
	reset: () => void;
}

const same = (a: Pick<AiMemoryDeleted, "workspace" | "project" | "path">, b: typeof a) =>
	a.workspace === b.workspace && a.project === b.project && a.path === b.path;

export const useMemoryPageStore = create<MemoryPageStore>()((set, get) => ({
	project: lastRead<AiMemoryProjectRef>(undefined, PROJECT_KEY) ?? null,
	setProject: project => {
		rememberRead(undefined, PROJECT_KEY, project);
		set({ project });
	},
	pending: null,
	openPage: target => {
		const project = { workspace: target.workspace, project: target.project };
		rememberRead(undefined, PROJECT_KEY, project);
		set(state => ({ pending: target, project, openRequest: state.openRequest + 1 }));
	},
	takePending: () => {
		const { pending } = get();
		if (pending) set({ pending: null });
		return pending;
	},
	deleted: lastRead<AiMemoryDeleted[]>(undefined, DELETED_KEY) ?? [],
	addDeleted: item => {
		const deleted = [item, ...get().deleted.filter(entry => !same(entry, item))].slice(0, DELETED_LIMIT);
		rememberRead(undefined, DELETED_KEY, deleted);
		set({ deleted });
	},
	removeDeleted: item => {
		const deleted = get().deleted.filter(entry => !same(entry, item));
		rememberRead(undefined, DELETED_KEY, deleted);
		set({ deleted });
	},
	version: 0,
	bump: () => set(state => ({ version: state.version + 1 })),
	openRequest: 0,
	reset: () => set({ project: null, pending: null, deleted: [], version: 0, openRequest: 0 }),
}));
