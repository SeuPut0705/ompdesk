/**
 * What the sidebar remembers, saved as one JSON blob under the `sidebar` prefs key: pinned projects and sessions,
 * project names, the dragged project and session order, archived sessions, the footer shortcuts, the workspace MRU
 * clock and the sessions hidden from other agents.
 *
 * The stored value in main is the only owner of the blob. A window or a paired page never writes the whole of it
 * from its own copy (a copy read earlier would put an older order back over a newer one): it sends one
 * `SidebarChange`, main applies it to the value stored now (`src/main/sidebar-prefs.ts`) and tells every other
 * window and page, which read the blob again. The rules below are the same for both sides, so a page shows a change
 * at once and main stores exactly what the page showed.
 */

export const SIDEBAR_PREFS_KEY = "sidebar";

/**
 * What the sidebar footer can hold above its destinations (mixdog's activity-rail
 * pins): usage bars for the tab's provider, side panel views, and Schedules.
 * The footer's Agents and Stats entries are pins too (off by default; the palette, the menu and ⌥A reach them). Only usage is on until the user chooses; Settings › General › Sidebar shortcuts picks them.
 */
export const RAIL_PINS = [
	"usage",
	"agents",
	"stats",
	"terminal",
	"diff",
	"preview",
	"files",
	"jobs",
	"schedules",
] as const;
export type RailPin = (typeof RAIL_PINS)[number];

/** Pins on until the user chooses: only the usage block, and only while no choice is saved. */
const DEFAULT_RAIL_PINS: readonly RailPin[] = ["usage"];

export interface SidebarPrefs {
	pinnedGroups: string[];
	pinnedSessions: string[];
	groupAliases: Record<string, string>;
	workspaceLastUsed: Record<string, number>;
	/** Project order the user set by dragging (cwds, top first); empty = by recency. */
	groupOrder: string[];
	/**
	 * Session order the user set in a list (session paths, top first), by the list's key: a project's cwd here,
	 * `<deviceId>\n<cwd>` for a paired host's project. A list with no entry, or a session not in it, goes by creation.
	 */
	sessionOrder: Record<string, string[]>;
	/** Ids of sessions hidden from the lists until restored. */
	archivedSessions: string[];
	/** Footer shortcuts in `RAIL_PINS` order. */
	railPins: RailPin[];
	/** Session files hidden from other agents (`ompdesk_*` tools refuse them). */
	agentHidden: string[];
}

/**
 * One change to the blob, naming only what it sets. A pin or a flag is set, never toggled, so two pages that both
 * mean "pinned" leave it pinned. Each is applied to the value stored at that moment, not to the sender's copy.
 */
export type SidebarChange =
	| { op: "set-group-pinned"; cwd: string; pinned: boolean }
	| { op: "set-session-pinned"; path: string; pinned: boolean }
	| { op: "set-agent-hidden"; path: string; hidden: boolean }
	/** An empty or absent alias shows the folder's own name again. */
	| { op: "set-group-alias"; cwd: string; alias: string | null }
	| { op: "set-group-order"; order: string[] }
	| { op: "set-session-order"; list: string; order: string[] }
	| { op: "set-sessions-archived"; ids: string[]; archived: boolean }
	| { op: "set-rail-pin"; pin: RailPin; pinned: boolean }
	| { op: "touch-workspace"; cwd: string };

const MAX_RECENT_WORKSPACES = 100;
/** Lists whose session order is kept (the most recently ordered first), and sessions kept per list. */
const MAX_ORDERED_LISTS = 300;
const MAX_ORDERED_SESSIONS = 500;

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.length > 0)
		: [];
}

function validRailPins(value: unknown): RailPin[] {
	// An absent entry is "not chosen yet"; any saved array, empty included, is the user's choice.
	if (value === undefined) return [...DEFAULT_RAIL_PINS];
	if (!Array.isArray(value)) return [];
	return RAIL_PINS.filter(pin => value.includes(pin));
}

function validAliases(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string> = {};
	for (const [cwd, alias] of Object.entries(value)) if (cwd && typeof alias === "string") out[cwd] = alias;
	return out;
}

function validSessionOrder(value: unknown): Record<string, string[]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string[]> = {};
	for (const [list, order] of Object.entries(value).slice(-MAX_ORDERED_LISTS)) {
		if (!list || !Array.isArray(order)) continue;
		const paths = stringList(order);
		if (paths.length > 0) out[list] = paths.slice(0, MAX_ORDERED_SESSIONS);
	}
	return out;
}

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

/** The stored blob as the sidebar holds it; malformed or missing parts fall back to defaults and unknown keys are dropped. */
export function readSidebarPrefs(value: unknown): SidebarPrefs {
	const blob = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof SidebarPrefs, unknown>>;
	return {
		pinnedGroups: stringList(blob.pinnedGroups),
		pinnedSessions: stringList(blob.pinnedSessions),
		groupAliases: validAliases(blob.groupAliases),
		workspaceLastUsed: validRecencyMap(blob.workspaceLastUsed),
		groupOrder: stringList(blob.groupOrder),
		sessionOrder: validSessionOrder(blob.sessionOrder),
		archivedSessions: stringList(blob.archivedSessions),
		railPins: validRailPins(blob.railPins),
		agentHidden: stringList(blob.agentHidden),
	};
}

function nextTimestamp(map: Record<string, number>, now: number): number {
	let latest = 0;
	for (const value of Object.values(map)) latest = Math.max(latest, value);
	return Math.max(now, latest + 1);
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

function withItem(list: string[], item: string, present: boolean): string[] {
	if (list.includes(item) === present) return list;
	return present ? [...list, item] : list.filter(entry => entry !== item);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}

type ListField = "pinnedGroups" | "pinnedSessions" | "groupOrder" | "archivedSessions" | "agentHidden";

/** Empty when the list already holds `next`, so a change that changes nothing writes nothing. */
function listPatch(state: SidebarPrefs, field: ListField, next: string[]): Partial<SidebarPrefs> {
	return sameList(state[field], next) ? {} : { [field]: next };
}

/**
 * The fields `change` moves when applied to `state`, empty when it moves none. `now` is the clock the workspace MRU
 * stamps with; it only has to grow, so a sender's clock and main's may differ.
 */
export function sidebarPatch(
	state: SidebarPrefs,
	change: SidebarChange,
	now: number = Date.now(),
): Partial<SidebarPrefs> {
	switch (change.op) {
		case "set-group-pinned":
			return listPatch(state, "pinnedGroups", withItem(state.pinnedGroups, change.cwd, change.pinned));
		case "set-session-pinned":
			return listPatch(state, "pinnedSessions", withItem(state.pinnedSessions, change.path, change.pinned));
		case "set-agent-hidden":
			return listPatch(state, "agentHidden", withItem(state.agentHidden, change.path, change.hidden));
		case "set-group-alias": {
			const alias = change.alias?.trim() || undefined;
			if (state.groupAliases[change.cwd] === alias) return {};
			const groupAliases = { ...state.groupAliases };
			if (alias) groupAliases[change.cwd] = alias;
			else delete groupAliases[change.cwd];
			return { groupAliases };
		}
		case "set-group-order":
			return listPatch(state, "groupOrder", [...new Set(stringList(change.order))]);
		case "set-session-order": {
			// The list just ordered moves to the end, so the oldest ordered lists are the ones a cap drops.
			const { [change.list]: _previous, ...rest } = state.sessionOrder;
			return { sessionOrder: validSessionOrder({ ...rest, [change.list]: [...new Set(change.order)] }) };
		}
		case "set-sessions-archived": {
			const ids = stringList(change.ids);
			return listPatch(
				state,
				"archivedSessions",
				change.archived
					? [...new Set([...state.archivedSessions, ...ids])]
					: state.archivedSessions.filter(id => !ids.includes(id)),
			);
		}
		case "set-rail-pin": {
			if (state.railPins.includes(change.pin) === change.pinned) return {};
			return {
				railPins: change.pinned
					? RAIL_PINS.filter(item => item === change.pin || state.railPins.includes(item))
					: state.railPins.filter(item => item !== change.pin),
			};
		}
		case "touch-workspace":
			return {
				workspaceLastUsed: touchedMap(
					state.workspaceLastUsed,
					change.cwd,
					nextTimestamp(state.workspaceLastUsed, now),
					MAX_RECENT_WORKSPACES,
				),
			};
	}
}
