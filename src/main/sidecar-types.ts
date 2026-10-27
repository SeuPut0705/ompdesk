/**
 * The tab-sidecar contract, on its own so the modules that drive a tab's omp (`sidecar-pool.ts`,
 * `turn-resume.ts`, `ipc.ts`, `remote/`) share it without importing one another.
 */
import type { EventEmitter } from "node:events";
import type { SidecarStatus, SidecarStatusPayload } from "../shared/rpc-types";
import type { ExtensionApplyPlan } from "./extension-reload";
import type { RpcClient } from "./rpc-client";
import type { SidecarStartGate } from "./sidecar";

/**
 * Emitted by a hosted view (remote/hosted-view.ts: a window here showing the tab this computer runs for a
 * paired device) when that device's tab ends (closed, deleted, revoked, its grace ran out): the window's tab
 * closes quietly, as a viewer's does when its owner closes, never as an exited omp.
 */
export const VIEW_ENDED_EVENT = "viewEnded";

/**
 * What the pool, ipc.ts and the host-tool executor need from a tab's sidecar:
 * the local SidecarManager, a RemoteSidecar whose omp runs on a paired host, or a HostedTabView of the omp
 * this computer runs for a paired device.
 * Events are SidecarManager's (see FRAME_EVENTS in sidecar.ts), re-emitted verbatim by remote ones, which
 * add `openAsks` (ExtensionUIRequest[]): every ask the host's omp holds, sent on each re-attach;
 * `awaitingConnection` (boolean): the host holds the turn for its connection; and `scheduledRetry`
 * (IpcScheduledRetry | undefined, on this computer's clock): the host's retry of a viewed window tab's failed turn.
 */
export interface SidecarLike extends Pick<EventEmitter, "on" | "off" | "once" | "removeAllListeners"> {
	readonly status: SidecarStatus;
	readonly statusPayload: SidecarStatusPayload;
	readonly cwd: string;
	readonly kind: "agent" | "chat";
	readonly rpcClient: Pick<RpcClient, "command"> | null;
	readonly processAlive: boolean;
	/** Paired host deviceId the omp runs on; absent for a local sidecar. */
	readonly device?: string;
	/** True while a remote sidecar's link to its host is down (commands fail with `remote_offline`). */
	readonly offline?: boolean;
	/**
	 * Another party works in the same omp (a hosted view, or a paired host's tab that views a window of that host):
	 * the tab lists as shared, so the host decides steer/follow-up and closing it only leaves.
	 */
	readonly shared?: boolean;
	/** True while a paired host's tab emits a status it derived from its link (down, reconnecting) rather
	 * than one the host's omp reported: that omp, and the asks it holds, may still be alive. */
	readonly statusFromLink?: boolean;
	start(): void;
	restart(cwd?: string, resumeSessionPath?: string): void;
	/** Local sidecars only: pick up an extension update or another session's MCP change in the live session. */
	reloadExtensions?(plan: Pick<ExtensionApplyPlan, "reconnect" | "mcp"> & { reload: boolean }): Promise<void>;
	adoptCwd(cwd: string): boolean;
	/** A local omp takes the frame at once. A paired host's tab returns a promise for a user's answer, and
	 * throws or rejects `remote_offline` (or the host's refusal) when the host did not take it (see RemoteSidecar). */
	sendSideChannel(frame: object): Promise<void> | void;
	syncImageGeneration(): void;
	/** Push this machine's reply-language setting to the live session (the omp's own machine decides). */
	syncReplyLanguage(): void;
	/** Push this machine's resolved default browser to the live session (the omp's own machine decides). */
	syncDefaultBrowser(): void;
	/** Push this machine's profile setting to the live session (the omp's own machine decides). */
	syncUserProfile(): void;
	/** Push this machine's prompt-suggestion switches to the live session (the omp's own machine decides). */
	syncNextPrompt(): void;
	/** Push this machine's automatic-title switches to the live session (the omp's own machine decides). */
	syncAutoTitle(): void;
	/** Push this machine's judge-assist switch to the live session (the omp's own machine decides). */
	syncJudgeAssist(): void;
	/** Local sidecars only: a direct request to the omp's own bridge (no RPC dispatch). Absent for a remote or hosted tab. */
	bridgeRequest?(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
	/** Re-register the GUI-executed host tools (the OMPdesk control tools follow their Settings switch). */
	syncHostTools(): void;
	/** Push this machine's account-rotation setting to the live omp (the omp's own machine decides). */
	syncAccountRotation(): void;
	dispose(): void;
	/** Local sidecars: hold the first spawn at `starting` until `gate` settles (worktree.onStart). */
	setStartGate?(gate: SidecarStartGate): void;
	/** Local sidecars: resolves once the omp process has exited. Call before dispose(). */
	whenExited?(): Promise<void>;
	/**
	 * Remote sidecars and hosted views: the user's Cancel on the waiting row or on a scheduled retry. The host (or, for a
	 * device's view of a window's tab, this computer's resume rules) holds that wait; a remote sidecar rejects
	 * `remote_offline` while the host is unreachable.
	 */
	cancelHostWait?(): Promise<void>;
}
