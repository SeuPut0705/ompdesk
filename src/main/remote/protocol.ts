/**
 * Message shapes of the remote-device protocol, validated at the socket
 * boundary. `HANDSHAKE_VERSION` is the `v` of probe/auth-init;
 * `PROTOCOL_VERSION` is the `protocol` of the encrypted hello.
 *
 * Version 2 has no pairing: who may connect is the host's Tailscale check
 * (`tailscale whois` of the peer's tailnet address), and each side pins the
 * other's static key on first contact (the host per Tailscale node).
 */
import { z } from "zod";
import { authTranscript, isRawKey } from "./crypto";

export const HANDSHAKE_VERSION = 2;
export const PROTOCOL_VERSION = 1;

/**
 * Why a host refused a connection (`auth-fail` or a probe's `error`):
 * - `not_tailnet`: the peer's address is no tailnet address;
 * - `no_identity`: Tailscale cannot say whose node it is (unknown, or a tagged node);
 * - `not_allowed`: the node's login is not on the host's allowed list;
 * - `blocked`: the host blocked this node;
 * - `declined`: the host's user declined (or did not answer) the new device;
 * - `key_mismatch`: this node, or this device id, is pinned to another key on the host;
 * - `protocol`: a handshake the host does not speak.
 */
export const REFUSAL_CODES = [
	"not_tailnet",
	"no_identity",
	"not_allowed",
	"blocked",
	"declined",
	"key_mismatch",
	"protocol",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

const rawKey = z.string().refine(isRawKey, "not a raw X25519 key");
const deviceId = z.string().min(1).max(64);
const deviceName = z.string().max(256);

/** First frame of any connection; `v` is checked before the full shape. */
export const Opening = z.object({ t: z.enum(["probe", "auth-init"]), v: z.unknown() });

export const ErrorMessage = z.object({ t: z.literal("error"), code: z.string().max(64) });

/** A probe passed the host's check: who answers, so a list can show it before connecting. */
export const ProbeReply = z.discriminatedUnion("t", [
	z.object({ t: z.literal("probe-ok"), deviceId, name: deviceName, appVersion: z.string().max(64) }),
	ErrorMessage,
]);

export const AuthInit = z.object({
	t: z.literal("auth-init"),
	v: z.number(),
	deviceId,
	name: deviceName,
	ephPub: rawKey,
	staticPub: rawKey,
});
export type AuthInit = z.infer<typeof AuthInit>;

export const AuthReply = z.discriminatedUnion("t", [
	z.object({ t: z.literal("auth-resp"), deviceId, name: deviceName, ephPub: rawKey, staticPub: rawKey }),
	z.object({ t: z.literal("auth-fail"), code: z.string().max(64) }),
	ErrorMessage,
]);

/** Any hello; `protocol` is checked before the side-specific shape. */
export const HelloVersion = z.object({ t: z.literal("hello"), protocol: z.unknown() });

/**
 * `slimEvents`: the device rebuilds slimmed `events` and `subagentFrame` messages (`link-events.ts`). It is a
 * capability of the hello, not a `PROTOCOL_VERSION` bump, because a host and a device must agree on the version
 * exactly: a bump would lock every older device out. A hello without it (an older device) gets whole frames, and an
 * older host ignores it.
 *
 * `slimProgress` (only ever sent with `slimEvents`): the device also rebuilds a subagent's `AgentProgress` snapshots
 * sent once or as a delta against the last one of the same subagent (in `subagent_progress` frames and in the task
 * tool's `tool_execution_update` `details.progress`), and takes `subagentFrame` tab events as arrays, one per flush.
 * A device that sent only `slimEvents` (v0.46.0) cannot read either, so it keeps single, whole frames.
 *
 * `slimAutopilot` (only ever sent with `slimEvents`): the device also rebuilds an `autopilot_update` status sent as a
 * delta against the last one of its tab (`link-events.ts`). A device without it (v0.52.7 and older) gets whole ones.
 *
 * `slimEnds` (only ever sent with `slimEvents`): the device also resolves a `message_end` or `agent_end` message sent
 * as a reference to the same message this connection already carried whole (`link-events.ts`). A device without it
 * (v0.53.0 and older) gets every message whole.
 *
 * `slimReadGroups` (only ever sent with `slimEnds`): such a reference may also carry `reads`, the read groups the
 * bridge adds to a committed reply's read calls. A device without it (v0.54.0) parses a reference strictly, so it
 * gets those replies whole.
 *
 * `slimEndFields` (only ever sent with `slimEnds`): such a reference may also carry `set` and `unset`, the top-level
 * fields stock changed after the message crossed (every reply's `completedAt`). A device without it (v0.56.0 and
 * older) parses a reference strictly, so it gets those messages whole.
 *
 * `slimAutopilotReads` (only ever sent with `slimAutopilot`): the device also rebuilds a `get_autopilot` answer sent as
 * a numbered delta against an earlier answer of this connection (`createReadEncoder`), and asks again with
 * `fresh` when it holds no such answer. A device without it (v0.58.0 and older) gets the whole status.
 *
 * `slimToolResults` (only ever sent with `slimEnds`): the device also rebuilds a tool result's `message_start` sent
 * as `{"~tool": toolCallId}` beside the fields its `tool_execution_end` did not carry: stock puts the same `content`
 * and `details` in both. A device without it (v0.54.0 and older) gets every tool result twice.
 *
 * `slimListReads` (only ever sent with `slimAutopilotReads`): the device also rebuilds a `get_available_commands`
 * answer and a `get_transcript_page` read from the end (`encodedReadKey`) sent as numbered deltas the same way. A
 * device without it (v0.59.1 and older) gets them whole.
 *
 * `slimShiftedReads` (only ever sent with `slimListReads`): such a delta's list may also be compared at an offset
 * (`shift`), as a running session's tail page starts later on each read. A device without it (v0.60.0) would read
 * the items at the wrong place, so its lists are compared index by index.
 *
 * `slimSettingsReads` (only ever sent with `slimListReads`): the device also rebuilds the reads Settings makes each
 * time it opens on a host's tab (`get_providers`, `get_settings_schema`, `get_model_roles`, `get_settings`) sent as
 * numbered deltas. A device without it (v0.61.3 and older) gets them whole.
 *
 * `slimRosterReads` (only ever sent with `slimListReads`): the device also rebuilds a `get_subagents` answer sent as a
 * numbered delta. A running turn with live subagents polls it every 3 s (about 32 KB each). A device without it
 * (v0.61.4 and older) gets it whole.
 *
 * `slimToolOutputs` (only ever sent with `slimEvents`): the device also rebuilds a `tool_execution_update` whose
 * running output, stock's whole text so far in every update, crosses as what follows the call's last update
 * (`{"~output": {from, add}}`). A device without it (v0.61.6 and older) gets every update's whole output.
 */
export const ClientHello = z.object({
	t: z.literal("hello"),
	protocol: z.number(),
	appVersion: z.string().max(64),
	name: deviceName,
	slimEvents: z.boolean().optional(),
	slimProgress: z.boolean().optional(),
	slimAutopilot: z.boolean().optional(),
	slimEnds: z.boolean().optional(),
	slimReadGroups: z.boolean().optional(),
	slimToolResults: z.boolean().optional(),
	slimEndFields: z.boolean().optional(),
	slimAutopilotReads: z.boolean().optional(),
	slimListReads: z.boolean().optional(),
	slimShiftedReads: z.boolean().optional(),
	slimSettingsReads: z.boolean().optional(),
	slimRosterReads: z.boolean().optional(),
	slimToolOutputs: z.boolean().optional(),
});

/**
 * What a connection's device reads beyond whole frames, from its hello (each flag above). A later capability counts
 * only with the ones it builds on: a device that dropped one gets whole frames for everything resting on it.
 */
export interface LinkSlim {
	events: boolean;
	progress: boolean;
	autopilot: boolean;
	ends: boolean;
	readGroups: boolean;
	toolResults: boolean;
	endFields: boolean;
	autopilotReads: boolean;
	listReads: boolean;
	shiftedReads: boolean;
	settingsReads: boolean;
	rosterReads: boolean;
	toolOutputs: boolean;
}

export function slimOf(hello: z.infer<typeof ClientHello>): LinkSlim {
	const events = hello.slimEvents === true;
	const ends = events && hello.slimEnds === true;
	const autopilotReads = events && hello.slimAutopilot === true && hello.slimAutopilotReads === true;
	const listReads = autopilotReads && hello.slimListReads === true;
	return {
		events,
		progress: events && hello.slimProgress === true,
		autopilot: events && hello.slimAutopilot === true,
		ends,
		readGroups: ends && hello.slimReadGroups === true,
		toolResults: ends && hello.slimToolResults === true,
		endFields: ends && hello.slimEndFields === true,
		autopilotReads,
		listReads,
		shiftedReads: listReads && hello.slimShiftedReads === true,
		settingsReads: listReads && hello.slimSettingsReads === true,
		rosterReads: listReads && hello.slimRosterReads === true,
		toolOutputs: events && hello.slimToolOutputs === true,
	};
}

/** Each capability's name in the host's `open` log line (`slim`). */
export const SLIM_LOG_NAMES: Readonly<Record<keyof LinkSlim, string>> = {
	events: "events",
	progress: "progress",
	autopilot: "autopilot",
	ends: "ends",
	readGroups: "reads",
	toolResults: "tools",
	endFields: "fields",
	autopilotReads: "status",
	listReads: "lists",
	shiftedReads: "shift",
	settingsReads: "settings",
	rosterReads: "roster",
	toolOutputs: "outputs",
};

export const HostHelloMessage = z.object({
	t: z.literal("hello"),
	protocol: z.number(),
	appVersion: z.string().max(64),
	name: deviceName,
	platform: z.string().max(32),
	ompVersion: z.string().max(64).nullable(),
	home: z.string(),
	sep: z.string().max(1),
});

export const WireRequest = z.object({
	t: z.literal("req"),
	id: z.number().int().nonnegative(),
	method: z.string().min(1).max(128),
	params: z.unknown(),
});

export const WireResponse = z.discriminatedUnion("ok", [
	z.object({ t: z.literal("res"), id: z.number(), ok: z.literal(true), result: z.unknown() }),
	z.object({
		t: z.literal("res"),
		id: z.number(),
		ok: z.literal(false),
		error: z.object({ code: z.string(), message: z.string() }),
	}),
]);

export const WireEvent = z.object({ t: z.literal("evt"), event: z.string().min(1).max(128), data: z.unknown() });

export interface AuthParty {
	deviceId: string;
	ephPub: string;
	staticPub: string;
}

/** The auth transcript hash: client (A) fields, then host (B) fields. */
export function authTranscriptOf(client: AuthParty, host: AuthParty): Buffer {
	return authTranscript([
		client.deviceId,
		client.ephPub,
		client.staticPub,
		host.deviceId,
		host.ephPub,
		host.staticPub,
	]);
}
