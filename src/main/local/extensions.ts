/**
 * Extensions domain (skills, hooks, prompt templates, MCP, plugins,
 * marketplaces, plugin themes, memory report, agent definitions, subagent
 * lifecycle, TUI themes).
 *
 * Stock omp has none of these RPC commands. The `omp skill|plugin` CLIs cannot
 * stand in: `omp skill list --json` drops disabled skills, `omp plugin
 * marketplace list` / `discover` / `config` print text only, and stock's
 * headless `/mcp` edits config files without touching live connections. So
 * the gui-bridge extension answers them in-process against the live session
 * (resources/gui-bridge/extensions/*), with the same result shapes the fork
 * returned. `abort_subagent` maps onto stock `cancel_subagent`. Subagent
 * transcripts (stock `get_subagent_messages`, the bridge's
 * `get_subagent_transcript`) come back as a transcript page's messages, with
 * their image bytes restored unless the caller asks for the references
 * (`imageRefs`: a paired device, which reads each blob once, `read_image_blob`).
 */

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { transcriptPageMessages } from "../../../resources/gui-bridge/transcript-page";
import type { RpcMcpServersResult } from "../../shared/rpc-types";
import { noteMcpChange } from "../mcp-live";
import { resolveImageBlobs } from "./image-blobs";
import { type LocalCommandContext, LocalCommandError, type LocalHandler } from "./types";

/** Forward a command to the bridge method of the same name, params minus the frame envelope. */
const viaBridge: LocalHandler = ({ type, id: _id, ...params }, ctx) => ctx.bridge.request(type, params);

const BRIDGED = [
	"get_skills",
	"get_skill_detail",
	"set_skill_enabled",
	"manage_skill",
	"get_hooks",
	"set_hook_enabled",
	"get_context_files",
	"set_context_file_enabled",
	"get_prompt_templates",
	"get_mcp_servers",
	"mcp_action",
	"mcp_test",
	"mcp_reauth_cancel",
	"get_plugins",
	"get_marketplaces",
	"marketplace_action",
	"set_plugin_enabled",
	"get_gui_themes",
	"get_plugin_detail",
	"set_plugin_features",
	"set_plugin_setting",
	"delete_plugin_setting",
	"get_agent_definitions",
	"get_agent_definition",
	"get_agent_authoring",
	"revive_subagent",
	"get_theme_colors",
	// One image's bytes by its blob reference: a paired device reads each picture of a subagent transcript once.
	"read_image_blob",
] as const;

/** Stock `cancel_subagent` aborts a running subagent this session owns and tombstones it. */
async function abortSubagent(command: Parameters<LocalHandler>[0], ctx: LocalCommandContext) {
	if (typeof command.agentId !== "string" || !command.agentId)
		throw new Error("`agentId` must be a non-empty string.");
	const { cancelled } = await ctx.send<{ cancelled: boolean }>({
		type: "cancel_subagent",
		subagentId: command.agentId,
	});
	// Stock refuses anything it does not list as a live subagent of this session (main, advisors, unknown, parked).
	return cancelled ? { ok: true } : { ok: false, reason: "not_found" };
}

/**
 * With `firstPrompt`, the read answers only its first user message: the sidebar recovers a subagent's assignment
 * from it, and the whole transcript (2.7 MB in a minute of one paired link's traffic, 22 Oct 2026) never crosses.
 * Stock's read has no limit, so main trims it on the computer the omp runs on.
 */
async function firstOnly<T extends { messages?: unknown }>(read: Promise<T>, firstPrompt: unknown): Promise<T> {
	const transcript = await read;
	if (firstPrompt !== true || !Array.isArray(transcript.messages)) return transcript;
	const first = transcript.messages.find(
		message => typeof message === "object" && message !== null && (message as { role?: unknown }).role === "user",
	);
	return { messages: first ? [first] : [] } as T;
}

/**
 * A transcript read as the renderer reads it: its `messages` as a transcript page's (no request bookkeeping, no
 * thinking signature) with their image bytes rather than stock's blob references, and without stock's `entries`, the
 * same messages again in their journal entries. Nothing reads either, and a subagent's journal is mostly them: 12.5 MB
 * of JSON a read for a 6 MB journal on 28 Oct 2026, 1.2 MB without (2.0 → 0.33 MB deflated), and a paired device
 * read one on every replay.
 *
 * `imageRefs`: the references stay (a paired device's `RemoteSidecar` asks so). The device keeps each blob by its
 * content address and reads only those it lacks, once (`read_image_blob`); a transcript's pictures were 70 % of its
 * deflated bytes over the subagent journals this Mac's sessions wrote on 30 Oct 2026 (143 MB with, 42 MB without).
 *
 * `tails`: the answer names the journal's `tail` at its `nextByte`, and a read from `knownTail` checks the journal
 * still has those bytes before `fromByte` (a device that kept what it read across its relaunch,
 * `remote/transcript-cache.ts`): a journal that does not is read again from its start, as `reset`.
 */
async function transcriptRead<T extends TranscriptAnswer>(
	read: (fromByte?: number) => Promise<T>,
	ctx: LocalCommandContext,
	{ imageRefs, tails, knownTail }: { imageRefs: unknown; tails: unknown; knownTail: unknown },
): Promise<Omit<T, "entries"> & { tail?: string }> {
	let answer = await read();
	if (
		typeof knownTail === "string" &&
		typeof answer.sessionFile === "string" &&
		answer.reset !== true &&
		typeof answer.fromByte === "number" &&
		answer.fromByte > 0 &&
		(await journalTail(answer.sessionFile, answer.fromByte)) !== knownTail
	)
		answer = { ...(await read(0)), reset: true };
	const { entries: _entries, ...transcript } = answer;
	const tail =
		tails === true && typeof transcript.sessionFile === "string" && typeof transcript.nextByte === "number"
			? await journalTail(transcript.sessionFile, transcript.nextByte)
			: null;
	if (!Array.isArray(transcript.messages)) return tail ? { ...transcript, tail } : transcript;
	const messages = transcriptPageMessages(transcript.messages);
	if (imageRefs !== true) await resolveImageBlobs(messages, ctx.bridge);
	return { ...transcript, messages, ...(tail ? { tail } : {}) };
}

/** What stock's journal read answers (`readRpcSubagentTranscript`), the fields a tail check reads. */
interface TranscriptAnswer {
	messages?: unknown;
	entries?: unknown;
	sessionFile?: unknown;
	fromByte?: unknown;
	nextByte?: unknown;
	reset?: unknown;
}

/** How many bytes before an offset a journal's `tail` covers: a line's end, enough to tell two journals apart. */
const TAIL_BYTES = 64;

/**
 * A journal's tail at `byte`: the offset and a hash of the bytes just before it. Stock only appends to a subagent's
 * journal, so a reader that kept what it read up to `byte` reads on from there while the tail is the same. Null when
 * the file cannot be read that far.
 */
export async function journalTail(file: string, byte: number): Promise<string | null> {
	if (byte <= 0) return "0";
	const start = Math.max(0, byte - TAIL_BYTES);
	const handle = await open(file, "r").catch(() => null);
	if (!handle) return null;
	try {
		const bytes = Buffer.alloc(byte - start);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
		if (bytesRead !== bytes.length) return null;
		return `${byte}:${createHash("sha256").update(bytes).digest("base64url").slice(0, 22)}`;
	} finally {
		await handle.close();
	}
}

/** A second reauth while one is in flight fails with the fork's `oauth_busy` code. */
async function mcpReauth(command: Parameters<LocalHandler>[0], ctx: LocalCommandContext) {
	const result = await ctx.bridge.request<{ busy?: string; ok?: boolean }>("mcp_reauth", { name: command.name });
	if (typeof result.busy === "string") {
		throw new LocalCommandError(
			`MCP OAuth reauthorization already in progress for "${result.busy}". Complete or cancel it before starting another.`,
			"oauth_busy",
		);
	}
	// The credential is shared by every omp of this computer: the other sessions connect with it now.
	if (result.ok === true && typeof command.name === "string") noteMcpChange({ names: [command.name] });
	return result;
}

/** Built-in declarations are read-only; only OMPdesk prefs control their next-session launch. */
const mcpAction: LocalHandler = async (command, ctx) => {
	if (typeof command.name !== "string" || !command.name.trim())
		throw new LocalCommandError("MCP server name must be a non-empty string", "invalid_params");
	const { servers } = await ctx.bridge.request<RpcMcpServersResult>("get_mcp_servers");
	if (servers.some(server => server.name === command.name && server.builtin === "rea"))
		throw new LocalCommandError("Use the built-in REA toggle; changes apply to new sessions", "invalid_params");
	const result = await viaBridge(command, ctx);
	noteMcpChange({ names: [command.name] });
	return result;
};

const mcpAdd: LocalHandler = async (command, ctx) => {
	const result = await viaBridge(command, ctx);
	if (typeof command.name === "string") noteMcpChange({ names: [command.name] });
	return result;
};

const mcpReload: LocalHandler = async (command, ctx) => {
	const result = await viaBridge(command, ctx);
	noteMcpChange({ names: [], all: true });
	return result;
};

export const handlers: Record<string, LocalHandler> = {
	...Object.fromEntries(BRIDGED.map(type => [type, viaBridge])),
	abort_subagent: abortSubagent,
	mcp_reauth: mcpReauth,
	mcp_action: mcpAction,
	mcp_add: mcpAdd,
	mcp_reload: mcpReload,
	get_subagent_messages: ({ id: _id, firstPrompt, imageRefs, tails, knownTail, ...command }, ctx) =>
		transcriptRead(
			fromByte =>
				firstOnly(
					ctx.send<TranscriptAnswer>(fromByte === undefined ? command : { ...command, fromByte }),
					firstPrompt,
				),
			ctx,
			{ imageRefs, tails, knownTail },
		),
	get_subagent_transcript: ({ type, id: _id, firstPrompt, imageRefs, tails, knownTail, ...params }, ctx) =>
		transcriptRead(
			fromByte =>
				firstOnly(
					ctx.bridge.request<TranscriptAnswer>(type, fromByte === undefined ? params : { ...params, fromByte }),
					firstPrompt,
				),
			ctx,
			{ imageRefs, tails, knownTail },
		),
};
