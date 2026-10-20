import * as fs from "node:fs";
import type { IpcTabWorktree, SessionKind } from "../shared/ipc-types";
import {
	asSplitLayout,
	mapSplitLeaves,
	readRememberedSplits,
	readSplitNode,
	type SplitLayout,
	splitTabIds,
} from "../shared/split-layout";
import { deletedSessions } from "./deleted-sessions";

export const TAB_LAYOUT_VERSION = 1;
/** A persisted title is display data only — bound it so prefs cannot grow. */
export const MAX_PERSISTED_TITLE = 120;

export interface PersistedTabDescriptor {
	cwd: string;
	sessionPath?: string;
	kind: SessionKind;
	worktree?: IpcTabWorktree;
	/** Untargeted startup tab, disposable once another real tab exists. */
	placeholder?: boolean;
	/**
	 * Last title the live session reported. A restored tab stays unspawned
	 * until it is shown, so this is the only title the chip can render in the
	 * meantime; the live session overwrites it on wake.
	 */
	title?: string;
	/**
	 * Paired host deviceId the tab runs on; absent = this machine. A remote
	 * tab's cwd and session file are the host's paths, so nothing about them
	 * is checked on this disk — the tab reconnects (or shows offline) on restore.
	 */
	device?: string;
	/**
	 * Session file of the session whose agent opened this tab (`ompdesk_session_open`); the sidebar nests the session
	 * under it again after a relaunch, once the opener's tab is back. A tab id would not do: every restored tab is new.
	 */
	openedBy?: string;
	/**
	 * The ids this tab had in earlier launches, newest first (≤ `MAX_FORMER_TAB_IDS`). Every restored tab gets a new id,
	 * and an agent given the old one (`ompdesk_session_open`, `ompdesk_sessions`) still reaches this session by it.
	 */
	formerIds?: string[];
}

export const MAX_FORMER_TAB_IDS = 8;

export interface PersistedTabLayout {
	version: typeof TAB_LAYOUT_VERSION;
	tabs: PersistedTabDescriptor[];
	activeIndex: number;
	/** Leaves store tab indices as strings, remapped to runtime ids on restore. */
	split?: SplitLayout;
	/**
	 * Splits remembered but not on screen (their sessions are shown alone or
	 * in another split right now); same index leaves. A session sits in at
	 * most one of `split` and `splits`.
	 */
	splits?: SplitLayout[];
}

export interface TabLayoutPathChecks {
	directoryExists(path: string): boolean;
	fileExists(path: string): boolean;
	/** Conservative content probe used only to migrate pre-placeholder layouts. */
	sessionHasContent?(path: string): boolean;
}

const diskPathChecks: TabLayoutPathChecks = {
	directoryExists(path) {
		try {
			return fs.statSync(path).isDirectory();
		} catch {
			return false;
		}
	},
	fileExists(path) {
		try {
			return fs.statSync(path).isFile();
		} catch {
			return false;
		}
	},
	sessionHasContent(path) {
		try {
			const file = fs.statSync(path);
			// Empty sessions are small. Treat a large transcript as contentful
			// without loading it into the main process during startup.
			if (file.size > 128 * 1024) return true;
			for (const line of fs.readFileSync(path, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					if ((JSON.parse(line) as { type?: unknown }).type === "message") return true;
				} catch {
					// A malformed line is not evidence that the transcript is empty.
					return true;
				}
			}
			return false;
		} catch {
			return true;
		}
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseKind(value: unknown): SessionKind | null {
	return value === "agent" || value === "chat" ? value : null;
}

/**
 * Bindings saved before `path` existed are dropped: the tab's saved cwd follows
 * session switches, so it cannot stand in for the checkout the close prompt
 * would remove with `--force`. The worktree itself stays on disk.
 */
function parseWorktree(value: unknown): IpcTabWorktree | undefined {
	if (!isRecord(value)) return undefined;
	const name = nonEmptyString(value.name);
	const branch = nonEmptyString(value.branch);
	const baseCwd = nonEmptyString(value.baseCwd);
	const path = nonEmptyString(value.path);
	return name && branch && baseCwd && path ? { name, branch, baseCwd, path } : undefined;
}

/**
 * Validate the tab snapshot loaded from electron-store before it reaches a
 * sidecar. Missing workspaces are dropped; a deleted transcript becomes a
 * fresh tab at the same cwd instead of making the whole startup fail. Remote
 * descriptors (`device`) skip both disk checks: their paths live on the host.
 */
export function sanitizePersistedTabLayout(
	value: unknown,
	paths: TabLayoutPathChecks = diskPathChecks,
): PersistedTabLayout | null {
	if (!isRecord(value) || value.version !== TAB_LAYOUT_VERSION || !Array.isArray(value.tabs)) return null;
	const requestedActiveIndex =
		typeof value.activeIndex === "number" && Number.isInteger(value.activeIndex) && value.activeIndex >= 0
			? value.activeIndex
			: 0;
	const retained: Array<{ descriptor: PersistedTabDescriptor; sourceIndex: number }> = [];
	const sessionPaths = new Set<string>();

	for (const [sourceIndex, candidate] of value.tabs.entries()) {
		if (!isRecord(candidate)) continue;
		const cwd = nonEmptyString(candidate.cwd);
		const kind = parseKind(candidate.kind);
		const device = nonEmptyString(candidate.device);
		if (!cwd || !kind || (!device && !paths.directoryExists(cwd))) continue;

		const storedSessionPath = nonEmptyString(candidate.sessionPath);
		// A deleted session's tab is gone with it: never a fresh tab in its folder, which is kept only for a file
		// that is missing without having been deleted (a session never written).
		if (storedSessionPath && deletedSessions().has(storedSessionPath, device)) continue;
		const sessionPath =
			storedSessionPath && (device || paths.fileExists(storedSessionPath)) ? storedSessionPath : undefined;
		// The same path on two machines is two files (F-OWN keys device + path too).
		const sessionKey = sessionPath && `${device ?? ""}\u0000${sessionPath}`;
		if (sessionKey && sessionPaths.has(sessionKey)) continue;
		if (sessionKey) sessionPaths.add(sessionKey);

		const descriptor: PersistedTabDescriptor = { cwd, kind };
		if (sessionPath) descriptor.sessionPath = sessionPath;
		if (device) descriptor.device = device;
		const worktree = parseWorktree(candidate.worktree);
		if (worktree) descriptor.worktree = worktree;
		const legacyEmptyStartupChat =
			candidate.placeholder === undefined &&
			sourceIndex === 0 &&
			kind === "chat" &&
			!device &&
			(!sessionPath || paths.sessionHasContent?.(sessionPath) === false);
		if (candidate.placeholder === true || legacyEmptyStartupChat) descriptor.placeholder = true;
		const title = nonEmptyString(candidate.title);
		if (title) descriptor.title = title.slice(0, MAX_PERSISTED_TITLE);
		// A path is only a key to match against another tab's session file; it is never opened from here.
		const openedBy = nonEmptyString(candidate.openedBy);
		if (openedBy && openedBy !== sessionPath) descriptor.openedBy = openedBy;
		const formerIds = Array.isArray(candidate.formerIds)
			? candidate.formerIds
					.flatMap(id => (typeof id === "string" && /^[\w:-]{1,64}$/.test(id) ? [id] : []))
					.slice(0, MAX_FORMER_TAB_IDS)
			: [];
		if (formerIds.length > 0) descriptor.formerIds = formerIds;
		retained.push({ descriptor, sourceIndex });
	}

	// Startup placeholders are disposable. Never restore the legacy empty
	// startup chat after Work mode became the default full-agent surface.
	const effective = retained.filter(entry => entry.descriptor.placeholder !== true);
	if (effective.length === 0) return null;
	let activeIndex = effective.findIndex(entry => entry.sourceIndex === requestedActiveIndex);
	if (activeIndex < 0) activeIndex = effective.findIndex(entry => entry.sourceIndex > requestedActiveIndex);
	if (activeIndex < 0) activeIndex = effective.length - 1;
	let split: PersistedTabLayout["split"];
	if (isRecord(value.split)) {
		const raw = value.split;
		const migrated =
			"firstIndex" in raw && "secondIndex" in raw
				? {
						axis: raw.axis,
						ratio: raw.ratio,
						first: { tabId: String(raw.firstIndex) },
						second: { tabId: String(raw.secondIndex) },
					}
				: raw;
		const parsed = readSplitNode(migrated);
		if (parsed) {
			split =
				asSplitLayout(
					mapSplitLeaves(parsed, source => {
						const index = effective.findIndex(entry => entry.sourceIndex === Number(source));
						return index >= 0 ? { tabId: String(index) } : null;
					}),
				) ?? undefined;
			if (split && !splitTabIds(split).includes(String(activeIndex))) activeIndex = Number(splitTabIds(split)[0]);
		}
	}
	// What is on screen (the visible split, else the active tab alone) is not also remembered.
	const claimed = new Set(split ? splitTabIds(split) : [String(activeIndex)]);
	const splits = readRememberedSplits(
		value.splits,
		source => {
			const index = effective.findIndex(entry => entry.sourceIndex === Number(source));
			return index >= 0 ? String(index) : null;
		},
		claimed,
	);

	return {
		version: TAB_LAYOUT_VERSION,
		tabs: effective.map(entry => entry.descriptor),
		activeIndex,
		...(split ? { split } : {}),
		...(splits.length > 0 ? { splits } : {}),
	};
}

/**
 * The whole session: one layout per window, in window order.
 *
 * Accepts the current array and the pre-multi-window shape (a bare layout
 * object), so an upgrade restores what the last version saved. Every tab
 * comes back: the pool restores them with `deferStart`, so a tab spawns its
 * process only once it is viewed.
 */
export function sanitizePersistedTabLayouts(
	value: unknown,
	paths: TabLayoutPathChecks = diskPathChecks,
): PersistedTabLayout[] {
	const candidates = Array.isArray(value) ? value : [value];
	const layouts: PersistedTabLayout[] = [];
	for (const candidate of candidates) {
		const layout = sanitizePersistedTabLayout(candidate, paths);
		if (layout) layouts.push(layout);
	}
	return layouts;
}
