/**
 * Application protocol between a client device (A) and the host it runs tabs
 * on (B), carried by RemoteClient/RemoteHost requests and events. `rtab` is
 * A's tabId; the host scopes it to the calling peer.
 *
 * Requests (A → B), served by host-services.ts:
 * - `tab.open {rtab, cwd?, defaultWorkspace?, kind?, fresh, sessionPath?}` → TabOpenResult
 * - `tab.start {rtab}`, `tab.restart {rtab, cwd?, sessionPath?}`, `tab.adoptCwd {rtab, cwd}`, `tab.close {rtab}`
 * - `tab.command {rtab, command, timeoutMs?}` → RpcResponse
 * - `tab.sideChannel {rtab, frame}`, `tab.syncImageGeneration {rtab}`
 * - `sessions.list|search|kindFor|delete|rename`, `fs.list|read|readImage|readPlan|listDirs`,
 *   `workspace.default`, `launchProfile.get|update`
 *
 * Events (B → A): `tab.event` (TabEventMessage) and `sessions.changed` (no data).
 * Both sides parse what crosses the link with the schemas below.
 */
import { z } from "zod";

/** SidecarManager events a host forwards for a remote tab; everything else stays on the host. */
export const TAB_EVENT_NAMES = [
	"status",
	"events",
	"extensionUi",
	"hostToolCall",
	"hostUriRequest",
	"subagentFrame",
	"liveFrame",
	"btwFrame",
	"modelCatalogUpdate",
	"commandsUpdate",
	"configUpdate",
	"promptResult",
	"sessionSettled",
	"commandOutput",
	"sessionInfoUpdate",
	"extensionError",
	"session",
	"bridge",
] as const;

export type TabEventName = (typeof TAB_EVENT_NAMES)[number];

export const TAB_EVENT = "tab.event";
export const SESSIONS_CHANGED_EVENT = "sessions.changed";

const SessionKind = z.enum(["agent", "chat"]);

export const TabEventMessage = z.object({
	rtab: z.string().min(1),
	name: z.enum(TAB_EVENT_NAMES),
	arg: z.unknown(),
});
export type TabEventMessage = z.infer<typeof TabEventMessage>;

/** `status` event argument: the payload plus what A cannot observe itself. */
export const TabStatusArg = z.object({
	status: z.enum(["asleep", "starting", "ready", "exited", "error", "restarting"]),
	statusPayload: z.object({
		message: z.string().optional(),
		restart: z.object({ attempt: z.number(), maxAttempts: z.number() }).optional(),
		modelFallback: z.string().optional(),
	}),
	processAlive: z.boolean(),
	cwd: z.string(),
	kind: SessionKind,
});
export type TabStatusArg = z.infer<typeof TabStatusArg>;

/** `session` event argument (SidecarSessionIdentity). */
export const TabSessionArg = z.object({
	sessionId: z.string().optional(),
	sessionFile: z.string().optional(),
});

/**
 * `bridge` event argument. The live bridge client never crosses: the host
 * runs the `capabilities` probe itself and sends its `unavailable` list.
 */
export const TabBridgeArg = z.discriminatedUnion("connected", [
	z.object({ connected: z.literal(true), ompVersion: z.string(), unavailable: z.unknown().optional() }),
	z.object({ connected: z.literal(false), ompVersion: z.string(), error: z.string() }),
]);
export type TabBridgeArg = z.infer<typeof TabBridgeArg>;

export interface TabOpenParams {
	rtab: string;
	cwd?: string;
	defaultWorkspace?: boolean;
	kind?: "agent" | "chat";
	fresh: boolean;
	/** Resumed by the first `tab.start`. */
	sessionPath?: string;
}

export const TabOpenResult = z.object({
	/** Canonical cwd on the host. */
	cwd: z.string(),
	kind: SessionKind,
	/**
	 * The host still held this tab (a reconnect inside the grace period): it
	 * re-sent `status`, and the sidecar keeps running — no `tab.start` needed.
	 */
	attached: z.boolean(),
});
export type TabOpenResult = z.infer<typeof TabOpenResult>;

/** RpcClient's default command timeout; the client waits this plus slack for `tab.command`. */
export const HOST_COMMAND_TIMEOUT_MS = 8_000;
/** Extra wait on top of a command's own timeout, covering the link round trip. */
export const LINK_SLACK_MS = 5_000;
