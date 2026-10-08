/**
 * SPAWN_TAB decision logic, extracted from ipc.ts so the refusal contracts
 * are directly testable without an Electron runtime. The handler stays a
 * thin shell: BrowserWindow lookup + this call.
 *
 * Two refusal codes, mirroring the F-OWN shape:
 * - `owned` — the session file is already attached to a tab (double-attach).
 * - `kind-mismatch` — the payload's requested kind disagrees with the file's
 *   stamped kind (I3: reject, never degrade). When the payload omits `kind`,
 *   the file's kind wins instead of refusing.
 *
 * A payload `device` opens the tab on a paired host: the session file, its
 * kind and the cwd are the host's, so they are looked up there, and the cwd
 * is left for the host to canonicalize.
 */

import type { BrowserWindow } from "electron";
import type { IpcSpawnTabPayload, IpcSpawnTabResult, SessionKind } from "../shared/ipc-types";
import { canonicalCwd } from "./canonical-cwd";
import type { SessionIndex } from "./session-index";
import type { SidecarPool } from "./sidecar-pool";
import { nextSnowflake } from "./snowflake";

/** Host-side lookups for a tab on a paired device. */
export interface SpawnTabRemote {
	kindFor(device: string, sessionPath: string): Promise<SessionKind>;
	defaultWorkspace(device: string): Promise<string>;
}

export type SpawnTabDeps = {
	sidecarPool: Pick<SidecarPool, "sessionOwner" | "atCap" | "acquire">;
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
};

export async function spawnTabForWindow(
	deps: SpawnTabDeps,
	win: BrowserWindow,
	payload: IpcSpawnTabPayload,
): Promise<IpcSpawnTabResult | null> {
	const device = typeof payload?.device === "string" && payload.device ? payload.device : undefined;
	const sessionPath =
		typeof payload?.sessionPath === "string" && payload.sessionPath ? payload.sessionPath : undefined;
	let kind: SessionKind = payload?.kind === "chat" ? "chat" : "agent";
	if (sessionPath) {
		// F-OWN first: a live owner wins over every other consideration.
		const owner = deps.sidecarPool.sessionOwner(sessionPath, device);
		if (owner) return { tabId: null, ownerTabId: owner.tabId, ownerWinId: owner.winId, refusal: "owned" };
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
	if (deps.sidecarPool.atCap) return null;
	const requested = typeof payload?.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : undefined;
	// A host's paths are canonicalized by the host; with no explicit or
	// same-device caller cwd, a remote tab opens in the host's Work workspace.
	const callerCwd = deps.fallbackCwd(device);
	const cwd = device
		? payload.defaultWorkspace
			? await deps.remote.defaultWorkspace(device)
			: (requested ?? callerCwd ?? (await deps.remote.defaultWorkspace(device)))
		: canonicalCwd(
				payload.defaultWorkspace ? deps.defaultWorkspace() : (requested ?? callerCwd ?? deps.initialCwd()),
			);
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
		false,
		false,
		undefined,
		device,
	)
		? payload.defaultWorkspace
			? { tabId, cwd }
			: { tabId }
		: null;
}
