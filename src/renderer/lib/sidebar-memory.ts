/**
 * What the left side remembers across relaunches, reloads and a reopened window: whether the docked sidebar is shown,
 * which project / folder / worktree / device groups are folded, each device's Chats section, the footer blocks (Get started,
 * usage), the Archived section and the sessions whose family rows are open or hidden.
 *
 * Three device-local prefs (`sidebarVisible`, `sidebarFolds`, `sidebarFamilies`; src/shared/device-prefs.ts: a paired
 * web page keeps them on that device, never on the host) with a localStorage mirror each, like the width
 * (`sidebar-width.ts`): the first React render reads the mirror synchronously, and `public/pre-paint.js` reads
 * `omp.sidebarVisible` before the first paint so the boot shell shows the sidebar as it was left. The pref is read
 * again after mount and wins when it differs.
 *
 * Bounded: each record keeps its newest `FOLD_LIMIT` entries, and the sidebar prunes folds of folders, devices and
 * sessions that no longer exist once a live read has confirmed what exists (`stores/sidebar-folds.ts`,
 * `stores/sidebar-subagents.ts`).
 */
import { SIDEBAR_VISIBLE_STORAGE_KEY } from "../../shared/boot-shell-geometry";
import { readPref } from "./prefs-read";

export const SIDEBAR_VISIBLE_PREF = "sidebarVisible";
export const SIDEBAR_FOLDS_PREF = "sidebarFolds";
export const SIDEBAR_FAMILIES_PREF = "sidebarFamilies";
export const SIDEBAR_FOLDS_STORAGE_KEY = "omp.sidebarFolds";
export const SIDEBAR_FAMILIES_STORAGE_KEY = "omp.sidebarFamilies";

/**
 * Entries each fold record (and each family list) keeps, the oldest-touched going first, and the longest key kept.
 * A paired web device's whole `uiPrefs` record is capped at 64 KiB (`DEVICE_UI_PREFS_MAX_BYTES`, src/main/web/
 * host-actions.ts) and a write over it is refused for every pref in it: five bounded lists stay far below that.
 */
export const FOLD_LIMIT = 50;
const KEY_MAX_CHARS = 200;

/** The device group key of "this device" while a host is paired. */
export const LOCAL_DEVICE = "local";

export interface SidebarFolds {
	/** Project / folder / worktree group (`WorkspaceGroup.cwd`) → folded. Absent = the default (current project open). */
	groups: Record<string, boolean>;
	/** `LOCAL_DEVICE` or a paired host's deviceId → folded. */
	devices: Record<string, boolean>;
	/** A paired host's folder group: `deviceGroupKey(deviceId, cwd)` → folded. */
	deviceGroups: Record<string, boolean>;
	/** `LOCAL_DEVICE` or a paired host's deviceId → its Chats section folded. */
	chats: Record<string, boolean>;
	/** The Archived section is open. */
	archivedOpen: boolean;
	/** The Get started checklist is open. */
	starterOpen: boolean;
	/** The footer usage block is folded to its header. */
	usageCollapsed: boolean;
	/** Device section order the user set (`LOCAL_DEVICE` or a host's deviceId), top first; `lib/device-order.ts`. */
	deviceOrder: string[];
	/** The paired hosts the last host-list read named, so the first frame draws their sections before the next read. */
	knownHosts: KnownHost[];
}

export interface KnownHost {
	id: string;
	name: string;
	/** It was offline then: its section is drawn as an offline one (no rows), so the read that confirms it moves nothing. */
	offline?: true;
}

export interface SidebarFamilies {
	/** Session paths whose family rows are expanded. */
	expanded: string[];
	/** Session paths whose subagent rows the user hid. */
	hidden: string[];
}

export const EMPTY_FOLDS: SidebarFolds = {
	groups: {},
	devices: {},
	deviceGroups: {},
	chats: {},
	archivedOpen: false,
	starterOpen: false,
	usageCollapsed: false,
	deviceOrder: [],
	knownHosts: [],
};

export function deviceGroupKey(deviceId: string, cwd: string): string {
	return `${deviceId}\n${cwd}`;
}

/** A record of `key → true|false`, malformed entries dropped, only the newest `FOLD_LIMIT` kept. */
function parseFlags(value: unknown): Record<string, boolean> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const entries = Object.entries(value).filter(
		(entry): entry is [string, boolean] =>
			typeof entry[1] === "boolean" && entry[0].length > 0 && entry[0].length <= KEY_MAX_CHARS,
	);
	return Object.fromEntries(entries.slice(-FOLD_LIMIT));
}

/** `record` with `key` set last (so it is the newest), within the limit. */
export function withFlag(record: Record<string, boolean>, key: string, value: boolean): Record<string, boolean> {
	const { [key]: _previous, ...rest } = record;
	return Object.fromEntries(Object.entries({ ...rest, [key]: value }).slice(-FOLD_LIMIT));
}

export function parseSidebarFolds(value: unknown): SidebarFolds {
	if (typeof value !== "object" || value === null) return EMPTY_FOLDS;
	const record = value as Record<string, unknown>;
	return {
		groups: parseFlags(record.groups),
		devices: parseFlags(record.devices),
		deviceGroups: parseFlags(record.deviceGroups),
		chats: parseFlags(record.chats),
		archivedOpen: record.archivedOpen === true,
		starterOpen: record.starterOpen === true,
		usageCollapsed: record.usageCollapsed === true,
		deviceOrder: parseDeviceOrder(record.deviceOrder),
		knownHosts: parseKnownHosts(record.knownHosts),
	};
}

/** Distinct ids, malformed ones dropped, within the limit. */
function parseDeviceOrder(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const ids = value.filter(
		(id): id is string => typeof id === "string" && id.length > 0 && id.length <= KEY_MAX_CHARS,
	);
	return [...new Set(ids)].slice(0, FOLD_LIMIT);
}

function parseKnownHosts(value: unknown): KnownHost[] {
	if (!Array.isArray(value)) return [];
	const hosts: KnownHost[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const { id, name, offline } = entry as Record<string, unknown>;
		if (typeof id !== "string" || id.length === 0 || id.length > KEY_MAX_CHARS) continue;
		if (typeof name !== "string" || name.length > KEY_MAX_CHARS || hosts.some(host => host.id === id)) continue;
		hosts.push(offline === true ? { id, name, offline: true } : { id, name });
	}
	return hosts.slice(0, FOLD_LIMIT);
}

/** A live tab's row key (`tab:<id>`) is not a session: it never outlives the tab, so it is never remembered. */
export function isRememberedSession(path: string): boolean {
	return path.length > 0 && path.length <= KEY_MAX_CHARS && !path.startsWith("tab:");
}

function parsePaths(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const paths = value.filter((entry): entry is string => typeof entry === "string" && isRememberedSession(entry));
	return [...new Set(paths)].slice(-FOLD_LIMIT);
}

export function parseSidebarFamilies(value: unknown): SidebarFamilies {
	if (typeof value !== "object" || value === null) return { expanded: [], hidden: [] };
	const record = value as Record<string, unknown>;
	return { expanded: parsePaths(record.expanded), hidden: parsePaths(record.hidden) };
}

/** `true`/`false` as saved; anything else (never saved, malformed) is null: the sidebar shows. */
export function parseSidebarVisible(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function readMirror(key: string): unknown {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? null : JSON.parse(raw);
	} catch {
		return null;
	}
}

function writeMirror(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// No storage: the pref still carries it.
	}
}

function writePref(key: string, value: unknown): void {
	try {
		void window.omp.prefs.set(key, value).catch(() => {});
	} catch {
		// No bridge (a test, a page still booting): the mirror carries it.
	}
}

/** Reads one pref; null when the read fails (the stored value is unknown: the mirror stands) or nothing was saved. */
export async function readSavedPref(key: string): Promise<unknown> {
	const read = await readPref(key);
	return read.ok ? (read.value ?? null) : null;
}

export function readSidebarVisible(): boolean {
	try {
		return localStorage.getItem(SIDEBAR_VISIBLE_STORAGE_KEY) !== "0";
	} catch {
		return true;
	}
}

export function writeSidebarVisible(visible: boolean): void {
	try {
		localStorage.setItem(SIDEBAR_VISIBLE_STORAGE_KEY, visible ? "1" : "0");
	} catch {
		// No storage: the pref still carries it.
	}
	writePref(SIDEBAR_VISIBLE_PREF, visible);
}

export function readSidebarFolds(): SidebarFolds {
	return parseSidebarFolds(readMirror(SIDEBAR_FOLDS_STORAGE_KEY));
}

/** Remembers `folds`, bounded: a key too long to keep still works in memory but is not saved. */
export function writeSidebarFolds(folds: SidebarFolds): void {
	const bounded = parseSidebarFolds(folds);
	writeMirror(SIDEBAR_FOLDS_STORAGE_KEY, bounded);
	writePref(SIDEBAR_FOLDS_PREF, bounded);
}

export function readSidebarFamilies(): SidebarFamilies {
	return parseSidebarFamilies(readMirror(SIDEBAR_FAMILIES_STORAGE_KEY));
}

export function writeSidebarFamilies(families: SidebarFamilies): void {
	writeMirror(SIDEBAR_FAMILIES_STORAGE_KEY, families);
	writePref(SIDEBAR_FAMILIES_PREF, families);
}
