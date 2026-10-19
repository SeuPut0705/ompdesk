/**
 * Application protocol between a client device (A) and the host it runs tabs
 * on (B), carried by RemoteClient/RemoteHost requests and events. `rtab` is
 * A's tabId; the host scopes it to the calling peer.
 *
 * Requests (A → B), served by host-services.ts:
 * - `tab.open {rtab, cwd?, kind?, fresh, sessionPath?}` → TabOpenResult
 * - `tab.start {rtab}`, `tab.restart {rtab, cwd?, sessionPath?}`, `tab.adoptCwd {rtab, cwd}`, `tab.close {rtab}`
 * - `tab.command {rtab, command, timeoutMs?}` → RpcResponse
 * - `tab.sideChannel {rtab, frame}`, `tab.syncImageGeneration {rtab}`
 * - `sessions.list|search|kindFor|delete|rename|move`, `fs.list|read|readImage|readPlan|listDirs`,
 *   `workspace.default`, `launchProfile.get|update`
 * - `host.fs.readBinary {rtab?, cwd?, path, maxBytes?}` → HostFsReadBinaryReply: the file
 *   viewer's bytes, base64 on the link, capped at FS_BINARY_REMOTE_MAX_BYTES by the host
 * - Settings, Usage and Stats of a remote tab read the host's own machine
 *   (machine-services.ts): `host.models.list {}` → CustomProvidersConfig (providers + stock options),
 *   `host.models.upsert {input: CustomProviderInput}`, `host.models.delete {id}`,
 *   `host.models.override {provider, modelId, override: ModelOverrideInput | null}`,
 *   `host.stats.fetch {path, params?}` → the stats reply,
 *   `host.bench.run {rtab?, cwd?, options}` → IpcBenchmarkRunResult, `host.bench.abort {}` → boolean,
 *   `host.modelSetup.run {request: ModelSetupRequest}` → IpcModelSetupRunResult,
 *   `host.modelSetup.status {}` → ModelSetupStatus, `host.modelSetup.abort {}` → boolean,
 *   `host.accountRotation.get {}` / `host.accountRotation.set {mode}` → AccountRotationState
 *   (the host's own pref; its sessions follow it)
 * - OMPdesk on the host: `host.desktop.get {}` → HostDesktopState (version, updater state,
 *   theme and language), `host.desktop.update {action: "check"|"download"|"install"}` → HostDesktopState
 *   (install restarts the host; refused with `host_busy` while anything runs there)
 * - omp on the host updates itself (omp-updater.ts): `host.ompUpdate.get {}` → OmpUpdateState,
 *   `host.ompUpdate.now {}` → OmpUpdateState (starts the host's own check and update in the
 *   background and answers at once); the host pushes every state change as the `host.ompUpdate.changed` event
 *
 * Events (B → A): `tab.event` (TabEventMessage), `sessions.changed` (no data) and `host.ompUpdate.changed`.
 * Both sides parse what crosses the link with the schemas below.
 */
import { z } from "zod";
import { ACCOUNT_ROTATION_MODES, type AccountRotationState } from "../../shared/account-rotation";
import type { BuiltinReaState } from "../../shared/builtin-mcp";
import { codedError, isIpcErrorCode } from "../../shared/ipc-error-codes";
import type {
	CustomModelEffort,
	CustomModelThinkingMode,
	CustomProviderApi,
	CustomProviderDiscoveryType,
	CustomProviderInput,
	HostDesktopState,
	IpcBenchmarkRunOptions,
	IpcFsReadBinaryResult,
	ModelOverrideInput,
	UpdateStatus,
} from "../../shared/ipc-types";
import type { ModelSetupStatus } from "../../shared/model-setup";
import { OMP_UPDATE_FAILURE_REASONS, type OmpUpdateState } from "../../shared/omp-update";
import { BLOCKING_UI_METHODS, type ExtensionUIRequest } from "../../shared/rpc-types";

/**
 * Events a host sends for a remote tab: the SidecarManager events it forwards (everything else
 * stays on the host), plus two the host derives, both re-sent on every `tab.open` of a tab it
 * still holds: `awaitingConnection` (boolean): the host holds the tab's turn until its own
 * internet connection is back (turn-resume.ts); `openAsks` (TabOpenAsksArg): every ask and
 * approval the tab's omp still waits on, the whole list, so the device replaces its own;
 * `signIn` (TabSignInArg): the provider sign-ins the tab is running.
 */
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
	"awaitingConnection",
	"openAsks",
	"signIn",
	// The tab views a window of the host (`TabOpenResult.viewing`) and that window closed it: the device's tab goes quietly.
	"viewEnded",
] as const;

export type TabEventName = (typeof TAB_EVENT_NAMES)[number];

export const TAB_EVENT = "tab.event";
export const SESSIONS_CHANGED_EVENT = "sessions.changed";
/** The host's omp update changed (data: OmpUpdateState); sent to every connected device. */
export const OMP_UPDATE_EVENT = "host.ompUpdate.changed";

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
	sessionName: z.string().optional(),
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

/**
 * `openAsks` event argument: the blocking extension-UI requests (`BLOCKING_UI_METHODS`) the
 * host tab's omp has open, whole, as it raised them. The body stays unchecked like a forwarded
 * `extensionUi` frame's; only what the device keys its open set on is.
 */
export const TabOpenAsksArg = z.array(
	z.custom<ExtensionUIRequest>(value => {
		if (typeof value !== "object" || value === null) return false;
		const { type, id, method } = value as Record<string, unknown>;
		return (
			type === "extension_ui_request" &&
			typeof id === "string" &&
			typeof method === "string" &&
			BLOCKING_UI_METHODS[method] === true
		);
	}),
);

/**
 * `signIn` event argument: the provider sign-ins (`login` commands) the host's tab is running now, by
 * provider id. Sent when one starts, when one answers (`ended`, with its error or null when it
 * connected) and on every `tab.open` of a held tab: a device that lost the link mid-`login` learns from
 * it whether that sign-in still runs, which decides if its re-sent code paste is the login panel's or a
 * leftover.
 */
export const TabSignInArg = z.object({
	active: z.array(z.string()),
	ended: z.object({ providerId: z.string(), error: z.string().nullable() }).optional(),
});
export type TabSignInArg = z.infer<typeof TabSignInArg>;

export const TabOpenResult = z.object({
	/** Canonical cwd on the host. */
	cwd: z.string(),
	kind: SessionKind,
	/**
	 * The host still held this tab (a reconnect inside the grace period): it
	 * re-sent `status` and `openAsks`, and the sidecar keeps running — no `tab.start` needed.
	 */
	attached: z.boolean(),
	/** The device views a tab a window of the host owns (one omp, shared): closing it only leaves. */
	viewing: z.boolean().optional(),
});
export type TabOpenResult = z.infer<typeof TabOpenResult>;

/** RpcClient's default command timeout; the client waits this plus slack for `tab.command`. */
export const HOST_COMMAND_TIMEOUT_MS = 8_000;
/** Extra wait on top of a command's own timeout, covering the link round trip. */
export const LINK_SLACK_MS = 5_000;

const StringRecord = z.record(z.string());
// Transport shape only: host ModelsConfigSchema is the authority for option values.
const ProviderApi = z.custom<CustomProviderApi>(value => typeof value === "string");
const Effort = z.custom<CustomModelEffort>(value => typeof value === "string");
const OptionalNumber = z.number().finite().optional();

const CustomProviderModelInputSchema = z.object({
	id: z.string().min(1),
	name: z.string().optional(),
	api: ProviderApi.optional(),
	baseUrl: z.string().optional(),
	reasoning: z.boolean().optional(),
	thinking: z
		.object({
			mode: z.custom<CustomModelThinkingMode>(value => typeof value === "string"),
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
	auth: z.custom<NonNullable<CustomProviderInput["auth"]>>(value => typeof value === "string").optional(),
	authHeader: z.boolean().optional(),
	headers: StringRecord.optional(),
	discovery: z
		.object({
			type: z.custom<CustomProviderDiscoveryType>(value => typeof value === "string"),
			timeoutMs: OptionalNumber,
		})
		.optional(),
	disableStrictTools: z.boolean().optional(),
	transport: z.literal("pi-native").optional(),
	extraBody: z.record(z.unknown()).optional(),
	models: z.array(CustomProviderModelInputSchema),
});

/** `host.models.override` entry: one model's overrides, checked before it touches the host's models.yml. */
export const ModelOverrideInputSchema: z.ZodType<ModelOverrideInput> = z.object({
	name: z.string().optional(),
	api: ProviderApi.optional(),
	reasoning: z.boolean().optional(),
	thinking: z
		.object({
			mode: z.custom<CustomModelThinkingMode>(value => typeof value === "string"),
			efforts: z.array(Effort).min(1),
			effortMap: z.record(z.string()).optional(),
		})
		.optional(),
	contextWindow: OptionalNumber,
	maxTokens: OptionalNumber,
	replayReasoning: z.boolean().optional(),
});

/** `host.bench.run` options; benchmarkArgs bounds the numbers and selectors. */
export const BenchmarkOptionsSchema: z.ZodType<IpcBenchmarkRunOptions> = z.object({
	models: z.array(z.string()).max(8),
	profile: z.enum(["mix", "chat", "prefill", "generation"]),
	runs: z.number().int(),
	parallel: z.number().int(),
	maxTokens: z.number().int().optional(),
});

/** `host.accountRotation.*` reply: the host's pref and whether its omp can rotate evenly. */
export const AccountRotationStateSchema: z.ZodType<AccountRotationState> = z.object({
	mode: z.enum(ACCOUNT_ROTATION_MODES),
	evenSupported: z.boolean().nullable(),
});

export const BuiltinReaStateSchema: z.ZodType<BuiltinReaState> = z.object({
	enabled: z.boolean(),
	available: z.boolean(),
	nodeVersion: z.string().optional(),
	reason: z.enum(["node-missing", "npx-missing", "node-version", "node-failed", "npx-failed"]).optional(),
});

/** `host.modelSetup.status` reply: whether this device's research runs on the host, and its last tool call. */
export const ModelSetupStatusSchema: z.ZodType<ModelSetupStatus> = z.object({
	running: z.boolean(),
	startedAt: z.number().optional(),
	activity: z.object({ tool: z.string(), detail: z.string().optional() }).optional(),
});

const Mode = z.enum(["automatic", "relaunch", "manual"]);
const UpdateStatusSchema: z.ZodType<UpdateStatus> = z.discriminatedUnion("state", [
	z.object({ state: z.literal("idle") }),
	z.object({ state: z.literal("checking") }),
	z.object({ state: z.literal("available"), version: z.string(), notes: z.string().optional(), mode: Mode }),
	z.object({ state: z.literal("downloading"), version: z.string(), mode: Mode, percent: z.number() }),
	z.object({ state: z.literal("downloaded"), version: z.string(), mode: Mode }),
	z.object({ state: z.literal("not-available"), version: z.string() }),
	z.object({
		state: z.literal("error"),
		message: z.string(),
		detail: z.string().optional(),
		showInBanner: z.boolean().optional(),
	}),
	z.object({ state: z.literal("auth-required"), reason: z.enum(["missing", "invalid", "denied"]) }),
]);

/** `host.desktop.*` reply: the host's OMPdesk version, updater state and appearance prefs. */
export const HostDesktopStateSchema: z.ZodType<HostDesktopState> = z.object({
	version: z.string(),
	update: UpdateStatusSchema,
	appearance: z.object({ themeName: z.string().nullable(), language: z.string().nullable() }),
});

/** `host.ompUpdate.*` reply and `host.ompUpdate.changed` event: the host's own OmpUpdater state. */
export const OmpUpdateStateSchema: z.ZodType<OmpUpdateState> = z.object({
	enabled: z.boolean(),
	scheduled: z.boolean(),
	phase: z.enum(["idle", "checking", "updating"]),
	installed: z.string().nullable(),
	latest: z.string().nullable(),
	checkedAt: z.number().nullable(),
	updatedTo: z.string().nullable(),
	failure: z.object({ reason: z.enum(OMP_UPDATE_FAILURE_REASONS), detail: z.string().optional() }).nullable(),
});

/** A host-level stats read waits for the host's own stats request (15 s) plus the link. */
export const HOST_STATS_TIMEOUT_MS = 20_000;

/** A file viewer read moves up to ~15 MB of base64 over the link; give it longer than a plain request. */
export const HOST_FS_READ_BINARY_TIMEOUT_MS = 60_000;

/** Standard base64 (what Buffer emits); a plain character class stays linear on a 15 MB string. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** `host.fs.readBinary` reply: IpcFsReadBinaryResult with `data` as base64, since the link carries JSON. */
export const HostFsReadBinaryReply = z.object({
	ok: z.boolean(),
	data: z
		.string()
		.regex(BASE64)
		.refine(data => data.length % 4 === 0, "base64 length"),
	mime: z.string().max(255),
	size: z.number().int().nonnegative(),
	truncated: z.boolean(),
	error: z.string().optional(),
	// A newer host may send a code this build does not know: keep the reply, drop the code.
	code: z.string().optional(),
});
export type HostFsReadBinaryReply = z.infer<typeof HostFsReadBinaryReply>;

/** Host side: the bytes go out as base64 without copying them first. */
export function encodeBinaryRead(result: IpcFsReadBinaryResult): HostFsReadBinaryReply {
	const { data, ...rest } = result;
	return { ...rest, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64") };
}

/**
 * Client side: parse the host's reply and decode the base64 straight into an
 * exact-size Uint8Array (its own ArrayBuffer, so IPC clones only these bytes).
 * A malformed reply throws `remote_protocol`.
 */
export function decodeBinaryRead(raw: unknown): IpcFsReadBinaryResult {
	const parsed = HostFsReadBinaryReply.safeParse(raw);
	if (!parsed.success) throw codedError("remote_protocol", "Malformed host.fs.readBinary reply");
	const { data, code, ...rest } = parsed.data;
	const bytes = new Uint8Array(Buffer.byteLength(data, "base64"));
	Buffer.from(bytes.buffer).write(data, "base64");
	return { ...rest, data: bytes, ...(isIpcErrorCode(code) ? { code } : {}) };
}
