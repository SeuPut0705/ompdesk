/**
 * The saved tab layout: its shape, and its reading back at launch. The rules (`sanitizePersistedTabLayout`: which saved
 * tabs come back and how) are the core's (`native/ompdesk/crates/core/src/pool/layout.rs`, unit 9e); this module is
 * their client. Whether a session was deleted stays main's (`deleted-sessions.ts`) and is asked; the folder, file and
 * content checks are the core's own reads unless the caller hands its own (tests).
 */
import type { IpcTabWorktree, SessionKind } from "../shared/ipc-types";
import type { SplitLayout } from "../shared/split-layout";
import { hub, sharedInstance } from "./core/hub";
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

/**
 * What a restore left out or changed of a saved tab, for the launch's `tab-layout` log line: `folder` (its folder is
 * gone), `deleted` (its session was deleted), `duplicate` (another tab of this layout holds that session), `fresh` (its
 * session file is missing without a tombstone, so it comes back as a new session in its folder).
 */
export type TabLayoutDrop = { reason: "folder" | "deleted" | "duplicate" | "fresh"; sessionPath?: string; cwd: string };

/** The path checks of the call in progress (null: the core reads the disk itself). */
let callerChecks: TabLayoutPathChecks | null = null;

const layoutInstance = sharedInstance("layout", (q, item) => {
	const path = item.path as string;
	if (q === "deleted") return deletedSessions().has(path, (item.device as string | null) ?? undefined);
	if (q === "directoryExists") return callerChecks?.directoryExists(path) ?? false;
	if (q === "fileExists") return callerChecks?.fileExists(path) ?? false;
	if (q === "sessionHasContent") return callerChecks?.sessionHasContent?.(path) ?? null;
	throw new Error(`the layout asks nothing called ${q}`);
});

function sanitize(
	value: unknown,
	paths: TabLayoutPathChecks | undefined,
	dropped: ((drop: TabLayoutDrop) => void) | undefined,
	many: boolean,
): unknown {
	callerChecks = paths ?? null;
	try {
		const { layout, drops } = hub().callOnce<{ layout: unknown; drops: TabLayoutDrop[] }>(
			layoutInstance,
			"sanitize",
			{
				value: value ?? null,
				asked: paths !== undefined,
				many,
			},
		);
		for (const drop of drops) dropped?.(drop);
		return layout;
	} finally {
		callerChecks = null;
	}
}

/**
 * Validate the tab snapshot loaded from electron-store before it reaches a sidecar. Missing workspaces are dropped; a
 * deleted transcript becomes a fresh tab at the same cwd instead of making the whole startup fail. Remote descriptors
 * (`device`) skip both disk checks: their paths live on the host.
 */
export function sanitizePersistedTabLayout(
	value: unknown,
	paths?: TabLayoutPathChecks,
	dropped?: (drop: TabLayoutDrop) => void,
): PersistedTabLayout | null {
	return sanitize(value, paths, dropped, false) as PersistedTabLayout | null;
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
	paths?: TabLayoutPathChecks,
	dropped?: (drop: TabLayoutDrop) => void,
): PersistedTabLayout[] {
	return sanitize(value, paths, dropped, true) as PersistedTabLayout[];
}
