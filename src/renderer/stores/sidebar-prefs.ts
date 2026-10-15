/**
 * Sidebar presentation prefs: pinned workspaces/sessions, workspace display
 * aliases (rename), the dragged project order, archived sessions (by id; stock
 * has no archive flag, so archiving only hides a session from the lists), the
 * projects-or-recent grouping, the shortcuts pinned to the sidebar footer, and
 * the workspace MRU clock the workspace
 * picker sorts by. Persisted as one JSON blob under the "sidebar" prefs key
 * via window.omp.prefs (electron-store in main); hydrate once at App mount.
 * Recency bookkeeping writes fire-and-forget; the pins, aliases and archive
 * the user can SEE are optimistic writes that roll back when the persist
 * rejects, so a row never stays pinned across a restart.
 */
import { create } from "zustand";
import { translate } from "../lib/i18n";
import { optimisticWrite } from "../lib/optimistic";
import { toastError } from "./toast";

const PREFS_KEY = "sidebar";

interface SidebarPrefsBlob {
	pinnedGroups?: string[];
	pinnedSessions?: string[];
	groupAliases?: Record<string, string>;
	workspaceLastUsed?: Record<string, number>;
	groupOrder?: string[];
	archivedSessions?: string[];
	grouping?: SidebarGrouping;
	railPins?: string[];
}

/**
 * What the sidebar footer can hold above its destinations (mixdog's activity-rail
 * pins): usage bars for the tab's provider, side panel views, and Schedules.
 * None by default; Settings › General › Sidebar shortcuts picks them.
 */
export const RAIL_PINS = ["usage", "terminal", "diff", "preview", "files", "jobs", "schedules"] as const;
export type RailPin = (typeof RAIL_PINS)[number];

/** Each pin's name, shared by its sidebar row and its Settings switch. */
export const RAIL_PIN_LABEL_KEYS: Record<RailPin, string> = {
	usage: "sidebar.pin.usage",
	terminal: "panel.tabs.terminal",
	diff: "panel.tabs.diff",
	preview: "panel.tabs.preview",
	files: "panel.tabs.files",
	jobs: "panel.tabs.jobs",
	schedules: "settings.section.schedules",
};

function validRailPins(value: unknown): RailPin[] {
	if (!Array.isArray(value)) return [];
	return RAIL_PINS.filter(pin => value.includes(pin));
}

/** Code sessions grouped under their project, or one list by recent activity. */
export type SidebarGrouping = "projects" | "recent";

interface SidebarPrefsStore {
	pinnedGroups: string[];
	pinnedSessions: string[];
	groupAliases: Record<string, string>;
	workspaceLastUsed: Record<string, number>;
	/** Project order the user set by dragging (cwds, top first); empty = by recency. */
	groupOrder: string[];
	/** Ids of sessions hidden from the lists until restored. */
	archivedSessions: string[];
	grouping: SidebarGrouping;
	/** Footer shortcuts in `RAIL_PINS` order. */
	railPins: RailPin[];
	hydrated: boolean;
	hydrate: () => Promise<void>;
	toggleGroupPin: (cwd: string) => Promise<void>;
	toggleSessionPin: (path: string) => Promise<void>;
	setGroupAlias: (cwd: string, alias: string | null) => Promise<void>;
	setGroupOrder: (order: string[]) => Promise<void>;
	setSessionsArchived: (ids: readonly string[], archived: boolean) => Promise<void>;
	setGrouping: (grouping: SidebarGrouping) => Promise<void>;
	toggleRailPin: (pin: RailPin) => Promise<void>;
	touchWorkspace: (cwd: string) => void;
	reset: () => void;
}

const MAX_RECENT_WORKSPACES = 100;

function validRecencyMap(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: Record<string, number> = {};
	for (const [key, timestamp] of Object.entries(value)) {
		if (key && typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) {
			result[key] = timestamp;
		}
	}
	return result;
}

function nextTimestamp(map: Record<string, number>): number {
	let latest = 0;
	for (const value of Object.values(map)) latest = Math.max(latest, value);
	return Math.max(Date.now(), latest + 1);
}

function touchedMap(
	current: Record<string, number>,
	key: string,
	timestamp: number,
	limit: number,
): Record<string, number> {
	const entries = Object.entries({ ...current, [key]: timestamp }).sort((a, b) => b[1] - a[1]);
	return Object.fromEntries(entries.slice(0, limit));
}

function prefsBlob(state: SidebarPrefsStore): SidebarPrefsBlob {
	return {
		pinnedGroups: state.pinnedGroups,
		pinnedSessions: state.pinnedSessions,
		groupAliases: state.groupAliases,
		workspaceLastUsed: state.workspaceLastUsed,
		groupOrder: state.groupOrder,
		archivedSessions: state.archivedSessions,
		grouping: state.grouping,
		railPins: state.railPins,
	};
}

/** Recency bookkeeping: a lost write costs an ordering hint, nothing the user
 *  set out to do, so it stays fire-and-forget. */
function persist(get: () => SidebarPrefsStore): void {
	void writePrefs(get);
}

async function writePrefs(get: () => SidebarPrefsStore): Promise<{ success: boolean; error?: string }> {
	try {
		await window.omp.prefs.set(PREFS_KEY, prefsBlob(get()));
		return { success: true };
	} catch (cause) {
		return { success: false, error: cause instanceof Error ? cause.message : String(cause) };
	}
}

export const useSidebarPrefs = create<SidebarPrefsStore>()((set, get) => ({
	pinnedGroups: [],
	pinnedSessions: [],
	groupAliases: {},
	workspaceLastUsed: {},
	groupOrder: [],
	archivedSessions: [],
	grouping: "projects",
	railPins: [],
	hydrated: false,

	hydrate: async () => {
		if (get().hydrated) return;
		try {
			const blob = (await window.omp.prefs.get(PREFS_KEY)) as SidebarPrefsBlob | null | undefined;
			set({
				pinnedGroups: Array.isArray(blob?.pinnedGroups) ? blob.pinnedGroups : [],
				pinnedSessions: Array.isArray(blob?.pinnedSessions) ? blob.pinnedSessions : [],
				groupAliases: blob?.groupAliases && typeof blob.groupAliases === "object" ? blob.groupAliases : {},
				workspaceLastUsed: validRecencyMap(blob?.workspaceLastUsed),
				groupOrder: Array.isArray(blob?.groupOrder)
					? blob.groupOrder.filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0)
					: [],
				archivedSessions: Array.isArray(blob?.archivedSessions)
					? blob.archivedSessions.filter((id): id is string => typeof id === "string" && id.length > 0)
					: [],
				grouping: blob?.grouping === "recent" ? "recent" : "projects",
				railPins: validRailPins(blob?.railPins),
				hydrated: true,
			});
		} catch {
			set({ hydrated: true });
		}
	},

	toggleGroupPin: cwd =>
		optimisticWrite({
			store: { getState: get, setState: set },
			mutate: state => ({
				pinnedGroups: state.pinnedGroups.includes(cwd)
					? state.pinnedGroups.filter(item => item !== cwd)
					: [...state.pinnedGroups, cwd],
			}),
			persist: () => writePrefs(get),
			onFailure: failure => toastError({ title: translate("sidebar.pinFailed"), error: failure }),
		}),

	toggleSessionPin: path =>
		optimisticWrite({
			store: { getState: get, setState: set },
			mutate: state => ({
				pinnedSessions: state.pinnedSessions.includes(path)
					? state.pinnedSessions.filter(item => item !== path)
					: [...state.pinnedSessions, path],
			}),
			persist: () => writePrefs(get),
			onFailure: failure => toastError({ title: translate("sidebar.pinFailed"), error: failure }),
		}),

	setGroupAlias: (cwd, alias) =>
		optimisticWrite({
			store: { getState: get, setState: set },
			mutate: state => {
				const groupAliases = { ...state.groupAliases };
				if (alias?.trim()) groupAliases[cwd] = alias.trim();
				else delete groupAliases[cwd];
				return { groupAliases };
			},
			persist: () => writePrefs(get),
			onFailure: failure => toastError({ title: translate("sidebar.renameFailed"), error: failure }),
		}),

	setGroupOrder: order =>
		optimisticWrite({
			store: { getState: get, setState: set },
			mutate: () => ({ groupOrder: [...new Set(order)] }),
			persist: () => writePrefs(get),
			onFailure: failure => toastError({ title: translate("sidebar.reorderFailed"), error: failure }),
		}),

	setSessionsArchived: (ids, archived) =>
		optimisticWrite({
			store: { getState: get, setState: set },
			mutate: state => ({
				archivedSessions: archived
					? [...new Set([...state.archivedSessions, ...ids])]
					: state.archivedSessions.filter(id => !ids.includes(id)),
			}),
			persist: () => writePrefs(get),
			onFailure: failure => toastError({ title: translate("sidebar.archiveFailed"), error: failure }),
		}),

	setGrouping: grouping =>
		optimisticWrite({
			store: { getState: get, setState: set },
			mutate: () => ({ grouping }),
			persist: () => writePrefs(get),
			onFailure: failure => toastError({ title: translate("sidebar.groupingFailed"), error: failure }),
		}),

	toggleRailPin: pin =>
		optimisticWrite({
			store: { getState: get, setState: set },
			mutate: state => ({
				railPins: state.railPins.includes(pin)
					? state.railPins.filter(item => item !== pin)
					: RAIL_PINS.filter(item => item === pin || state.railPins.includes(item)),
			}),
			persist: () => writePrefs(get),
			onFailure: failure => toastError({ title: translate("sidebar.pinFailed"), error: failure }),
		}),

	touchWorkspace: cwd => {
		if (!cwd) return;
		const state = get();
		const timestamp = nextTimestamp(state.workspaceLastUsed);
		set({ workspaceLastUsed: touchedMap(state.workspaceLastUsed, cwd, timestamp, MAX_RECENT_WORKSPACES) });
		persist(get);
	},

	reset: () =>
		set({
			pinnedGroups: [],
			pinnedSessions: [],
			groupAliases: {},
			workspaceLastUsed: {},
			groupOrder: [],
			archivedSessions: [],
			grouping: "projects",
			railPins: [],
			hydrated: false,
		}),
}));
