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
 * - Settings, Usage and Stats of a remote tab read the host's own machine
 *   (machine-services.ts): `host.models.list {}` → CustomProviderView[],
 *   `host.models.upsert {input: CustomProviderInput}`, `host.models.delete {id}`,
 *   `host.stats.fetch {path, params?}` → the stats reply,
 *   `host.bench.run {rtab?, cwd?, options}` → IpcBenchmarkRunResult, `host.bench.abort {}` → boolean
 *
 * Events (B → A): `tab.event` (TabEventMessage) and `sessions.changed` (no data).
 * Both sides parse what crosses the link with the schemas below.
 */
import { z } from "zod";
import {
	CUSTOM_MODEL_EFFORTS,
	CUSTOM_PROVIDER_APIS,
	type CustomProviderInput,
	type IpcBenchmarkRunOptions,
} from "../../shared/ipc-types";

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

const StringRecord = z.record(z.string());
const ProviderApi = z.enum(CUSTOM_PROVIDER_APIS);
const Effort = z.enum(CUSTOM_MODEL_EFFORTS);
const OptionalNumber = z.number().finite().optional();

const CustomProviderModelInputSchema = z.object({
	id: z.string().min(1),
	name: z.string().optional(),
	api: ProviderApi.optional(),
	baseUrl: z.string().optional(),
	reasoning: z.boolean().optional(),
	thinking: z
		.object({
			mode: z.enum(["effort", "budget", "google-level", "anthropic-adaptive", "anthropic-budget-effort"]),
			efforts: z.array(Effort),
			defaultLevel: Effort.optional(),
			supportsDisplay: z.boolean().optional(),
		})
		.optional(),
	input: z.array(z.enum(["text", "image"])).optional(),
	supportsTools: z.boolean().optional(),
	cost: z
		.object({ input: OptionalNumber, output: OptionalNumber, cacheRead: OptionalNumber, cacheWrite: OptionalNumber })
		.optional(),
	premiumMultiplier: OptionalNumber,
	contextWindow: OptionalNumber,
	maxTokens: OptionalNumber,
	omitMaxOutputTokens: z.boolean().optional(),
	headers: StringRecord.optional(),
});

/** `host.models.upsert` input: the Settings form's provider, checked before it touches the host's models.yml. */
export const CustomProviderInputSchema: z.ZodType<CustomProviderInput> = z.object({
	id: z.string().min(1).max(200),
	api: ProviderApi,
	baseUrl: z.string(),
	apiKey: z.string().optional(),
	clearApiKey: z.boolean().optional(),
	auth: z.enum(["apiKey", "none", "oauth"]).optional(),
	authHeader: z.boolean().optional(),
	headers: StringRecord.optional(),
	discovery: z
		.object({
			type: z.enum(["ollama", "llama.cpp", "lm-studio", "openai-models-list", "proxy", "litellm"]),
			timeoutMs: OptionalNumber,
		})
		.optional(),
	disableStrictTools: z.boolean().optional(),
	transport: z.literal("pi-native").optional(),
	extraBody: z.record(z.unknown()).optional(),
	models: z.array(CustomProviderModelInputSchema),
});

/** `host.bench.run` options; benchmarkArgs bounds the numbers and selectors. */
export const BenchmarkOptionsSchema: z.ZodType<IpcBenchmarkRunOptions> = z.object({
	models: z.array(z.string()).max(8),
	profile: z.enum(["mix", "chat", "prefill", "generation"]),
	runs: z.number().int(),
	parallel: z.number().int(),
	maxTokens: z.number().int().optional(),
});

/** A host-level stats read waits for the host's own stats request (15 s) plus the link. */
export const HOST_STATS_TIMEOUT_MS = 20_000;
