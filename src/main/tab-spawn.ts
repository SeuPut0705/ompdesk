/**
 * SPAWN_TAB decision logic, extracted from ipc.ts so the refusal contracts
 * are directly testable without an Electron runtime. The handler stays a
 * thin shell: the caller's window + this call.
 *
 * Two refusal codes, mirroring the F-OWN shape:
 * - `owned` — the session file is already attached to a tab (double-attach).
 * - `kind-mismatch` — the payload's requested kind disagrees with the file's
 *   stamped kind (I3: reject, never degrade). When the payload omits `kind`,
 *   the file's kind wins instead of refusing.
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

import type { IpcSpawnTabPayload, IpcSpawnTabResult, SessionKind } from "../shared/ipc-types";
import { canonicalCwd } from "./canonical-cwd";
import type { SessionIndex } from "./session-index";
import type { SidecarPool } from "./sidecar-pool";
import type { SidecarLike } from "./sidecar-types";
import { nextSnowflake } from "./snowflake";
import { type ClientWindow, isWebWindow } from "./web/client-window";

/** Host-side lookups for a tab on a paired device. */
export interface SpawnTabRemote {
	kindFor(device: string, sessionPath: string): Promise<SessionKind>;
	defaultWorkspace(device: string): Promise<string>;
}

export type SpawnTabDeps = {
	sidecarPool: Pick<SidecarPool, "sessionOwner" | "acquire" | "attachViewer" | "acquireHostedView">;
	sessionIndex: Pick<SessionIndex, "kindFor">;
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
		: canonicalCwd(neutral ? deps.defaultWorkspace() : (requested ?? callerCwd ?? deps.initialCwd()));
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
