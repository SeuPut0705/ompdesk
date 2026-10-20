/**
 * SPAWN_TAB decision logic, extracted from ipc.ts so the refusal contracts
 * are directly testable without an Electron runtime. The handler stays a
 * thin shell: the caller's window + this call.
 *
 * Three refusal codes, mirroring the F-OWN shape:
 * - `owned` — the session file is already attached to a tab (double-attach).
 * - `kind-mismatch` — the payload's requested kind disagrees with the file's
 *   stamped kind (I3: reject, never degrade). When the payload omits `kind`,
 *   the file's kind wins instead of refusing.
 * - `folder-missing` — a stored session opens in the folder its file records
 *   (stock's header cwd), whatever folder the caller is in; when that folder
 *   is gone it is refused (`folder`) instead of opening anywhere else. Stock
 *   would relocate a removed worktree's session into the launch folder, the
 *   repository's main checkout (v0.46.0 reopened one there).
 *
 * When a paired web device's window is involved (the caller or the owner),
 * an owned session is not refused: the caller's window views the owner's tab
 * (`attached`). Between Electron windows the owner keeps it and is focused.
 *
 * A session a paired device's tab runs on THIS computer (LocalHostServices,
 * `hosted`) is viewed too: the window gets that tab's omp as a hosted view
 * (`attached`), never a second omp on the file.
 *
 * A payload `device` opens the tab on a paired host: the session file, its
 * kind and the cwd are the host's, so they are looked up there, and the cwd
 * is left for the host to canonicalize.
 *
 * A chat tab is a full agent outside any project: whatever the caller's
 * folder, it always runs in the GUI-owned default workspace (the host's for
 * a remote tab), exactly like an explicit `defaultWorkspace` request.
 */

import { stat } from "node:fs/promises";
import type { SavedWorktree } from "../shared/disk-care";
import type { IpcSavedFolder, IpcSpawnTabPayload, IpcSpawnTabResult, SessionKind } from "../shared/ipc-types";
import { canonicalCwd } from "./canonical-cwd";
import type { SessionIndex } from "./session-index";
import type { SidecarPool } from "./sidecar-pool";
import type { SidecarLike } from "./sidecar-types";
import { nextSnowflake } from "./snowflake";
import { type ClientWindow, isWebWindow } from "./web/client-window";

/** Where a stored session belongs and whether it can open there (`sessionFolderState`). */
export interface SessionFolderState {
	/** The folder its file records, or null when it records none. */
	folder: string | null;
	/** The recorded folder is gone (after a restore that was asked for, if any). */
	missing: boolean;
	/** With `missing`: disk care saved that folder before removing it. */
	saved: IpcSavedFolder | null;
}

/** What `sessionFolderState` reads: this computer's session index and saved worktrees. */
export interface SessionFolderSources {
	recordedCwd(sessionPath: string): Promise<string | null>;
	savedWorktrees?: SpawnTabDeps["savedWorktrees"];
}

/**
 * The folder a stored session opens in, read on the computer that holds its file: this one for a local open, a paired
 * host for its own (`sessions.folder` in remote/host-services.ts), so a device's open follows the same rule. A failed
 * read throws (never "none recorded"); `restore` puts back a folder disk care saved before saying it is missing.
 */
export async function sessionFolderState(
	sources: SessionFolderSources,
	sessionPath: string,
	restore: boolean,
): Promise<SessionFolderState> {
	const folder = await sources.recordedCwd(sessionPath);
	if (!folder) return { folder: null, missing: false, saved: null };
	const exists = () =>
		stat(folder).then(
			info => info.isDirectory(),
			() => false,
		);
	if (await exists()) return { folder, missing: false, saved: null };
	// Not knowing whether disk care saved it (its store not read yet) still refuses: only the offer is missing.
	const saved = (await sources.savedWorktrees?.find(folder).catch(() => null)) ?? null;
	if (saved && restore) {
		await sources.savedWorktrees?.restore(saved.id);
		if (await exists()) return { folder, missing: false, saved: null };
	}
	return {
		folder,
		missing: true,
		saved: saved ? { id: saved.id, branch: saved.branch, removedAt: saved.removedAt } : null,
	};
}

/** Host-side lookups for a tab on a paired device. */
export interface SpawnTabRemote {
	kindFor(device: string, sessionPath: string): Promise<SessionKind>;
	defaultWorkspace(device: string): Promise<string>;
	/** `sessionFolderState` on that host; rejects on a host too old to answer, whose own `tab.open` still refuses. */
	sessionFolder?(device: string, sessionPath: string, restore: boolean): Promise<SessionFolderState>;
}

export type SpawnTabDeps = {
	sidecarPool: Pick<SidecarPool, "sessionOwner" | "acquire" | "attachViewer" | "acquireHostedView">;
	sessionIndex: Pick<SessionIndex, "kindFor" | "recordedCwd">;
	/**
	 * The caller's cwd when its tab runs on `device` (undefined = this
	 * machine), else null; a local spawn then falls back to the app's initial cwd.
	 */
	fallbackCwd: (device: string | undefined) => string | null;
	/** The app's initial cwd, for a local spawn with no caller cwd. */
	initialCwd: () => string;
	/** GUI-owned Work workspace, created on demand. */
	defaultWorkspace: () => string;
	remote: SpawnTabRemote;
	/**
	 * Test hook (env `OMP_GUI_TEST_VIEWER_WINDOWS=1`): any window, not only a paired web device's, views a
	 * session another window holds. It lets the two-window e2e run on Electron windows.
	 */
	anyWindowViews?: boolean;
	/** The tabs this computer runs for paired devices: a view of the one holding a session, else null. */
	hosted?: { viewSession(sessionPath: string): SidecarLike | null };
	/** Worktrees disk care saved before removing them (`disk/saved-worktrees.ts`): what a gone folder can come back from. */
	savedWorktrees?: {
		/** The saved record of exactly that folder, if disk care took it. */
		find(folder: string): Promise<Pick<SavedWorktree, "id" | "branch" | "removedAt"> | null>;
		restore(id: string): Promise<unknown>;
	};
};

export async function spawnTabForWindow(
	deps: SpawnTabDeps,
	win: ClientWindow,
	payload: IpcSpawnTabPayload,
): Promise<IpcSpawnTabResult | null> {
	const device = typeof payload?.device === "string" && payload.device ? payload.device : undefined;
	const sessionPath =
		typeof payload?.sessionPath === "string" && payload.sessionPath ? payload.sessionPath : undefined;
	let kind: SessionKind = payload?.kind === "chat" ? "chat" : "agent";
	let home: string | undefined;
	if (sessionPath) {
		// F-OWN first: a live owner wins over every other consideration.
		const owner = deps.sidecarPool.sessionOwner(sessionPath, device);
		if (owner) {
			const callerId = win.webContents.id;
			const shared =
				owner.winId !== callerId &&
				(deps.anyWindowViews === true || isWebWindow(callerId) || isWebWindow(owner.winId));
			if (shared && deps.sidecarPool.attachViewer(win, owner.tabId)) return { tabId: owner.tabId, attached: true };
			return { tabId: null, ownerTabId: owner.tabId, ownerWinId: owner.winId, refusal: "owned" };
		}
		const view = device ? null : (deps.hosted?.viewSession(sessionPath) ?? null);
		if (view) {
			// Agent and chat sessions never convert, here either.
			if (payload?.kind !== undefined && payload.kind !== view.kind) {
				view.dispose();
				return { tabId: null, refusal: "kind-mismatch" };
			}
			const tabId = nextSnowflake();
			if (deps.sidecarPool.acquireHostedView(win, tabId, view, sessionPath)) return { tabId, attached: true };
			view.dispose();
			return null;
		}
		// F-KIND: the file's stamped kind is authoritative. Refuse a mismatched
		// explicit request; defer to the file when the payload omits kind.
		const fileKind = device
			? await deps.remote.kindFor(device, sessionPath)
			: await deps.sessionIndex.kindFor(sessionPath);
		if (payload?.kind !== undefined && fileKind !== kind) {
			return { tabId: null, refusal: "kind-mismatch" };
		}
		kind = fileKind;
		// A stored agent session runs where its file says, never where the caller happens to be: read on the computer
		// that holds the file. A host too old to answer a plain lookup still refuses a gone folder in its own
		// `tab.open`; a restore that fails or outlasts its wait opens nothing (its worktree may be half put back).
		if (kind !== "chat") {
			const restore = payload.restoreSaved === true;
			const asked = device ? deps.remote.sessionFolder?.(device, sessionPath, restore) : undefined;
			const state = device
				? restore
					? await asked
					: await asked?.catch(() => null)
				: await sessionFolderState(
						{ recordedCwd: path => deps.sessionIndex.recordedCwd(path), savedWorktrees: deps.savedWorktrees },
						sessionPath,
						restore,
					);
			if (state?.missing)
				return {
					tabId: null,
					refusal: "folder-missing",
					...(state.folder ? { folder: state.folder } : {}),
					...(state.saved ? { saved: state.saved } : {}),
				};
			if (!device && state?.folder) home = state.folder;
		}
	}
	const requested = typeof payload?.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : undefined;
	const neutral = payload.defaultWorkspace === true || kind === "chat";
	// A host's paths are canonicalized by the host; with no explicit or
	// same-device caller cwd, a remote tab opens in the host's Work workspace.
	const callerCwd = deps.fallbackCwd(device);
	const cwd = device
		? neutral
			? await deps.remote.defaultWorkspace(device)
			: (requested ?? callerCwd ?? (await deps.remote.defaultWorkspace(device)))
		: canonicalCwd(neutral ? deps.defaultWorkspace() : (home ?? requested ?? callerCwd ?? deps.initialCwd()));
	const tabId = nextSnowflake();
	// A no-path tab is an explicit New Tab action. It must start empty even
	// when the CLI's persistent autoResume setting is enabled for the project.
	return deps.sidecarPool.acquire(
		cwd,
		win,
		tabId,
		sessionPath,
		kind,
		payload?.worktree,
		!sessionPath,
		payload?.placeholder === true && !sessionPath,
		false,
		undefined,
		device,
		typeof payload?.task === "string" && payload.task ? payload.task : undefined,
	)
		? neutral
			? { tabId, cwd }
			: { tabId }
		: null;
}
