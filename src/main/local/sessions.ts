/**
 * Session & transcript commands answered GUI-side.
 *
 * Stock omp has no `get_transcript`: it exposes the raw session tree through
 * `get_entries`. The display transcript is projected here the way omp's own
 * `buildSessionContext({ transcript: true })` does it — every entry on the
 * root→leaf path in order, compactions inline, dangling tool calls stripped —
 * with each message stamped with the `entryId` of the entry it came from.
 */
import { resolve } from "node:path";
import { z } from "zod";
import type { AgentMessage, MessagesPage, RpcSessionTreeResult, RpcSwitchLeafResult } from "../../shared/rpc-types";
import { handlers as extraHandlers } from "./session-extras";
import { deleteSessionFiles, renameStoredSession } from "./session-files";
import { projectSessionTree } from "./session-tree";
import { type BridgeClient, type LocalCommandContext, LocalCommandError, type LocalHandler } from "./types";

/** One persisted session-tree entry as `get_entries` returns it. */
export interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	/** Present on `type: "message"` entries. */
	message?: AgentMessage;
	[key: string]: unknown;
}

export interface EntriesSnapshot {
	entries: SessionEntry[];
	leafId: string | null;
}

/** omp's text for a compaction a later compaction replaced (session/session-context.ts). */
const SUPERSEDED_COMPACTION_SUMMARY = "[Superseded compaction summary elided after a newer compaction]";
const SUPERSEDED_COMPACTION_SHORT_SUMMARY = "Superseded compaction elided";

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 256;

function entryTime(entry: SessionEntry): number {
	return new Date(entry.timestamp).getTime();
}

/** Root→leaf path; a parent cycle in a corrupt file stops the walk. */
function branchPath(entries: readonly SessionEntry[], leafId: string | null): SessionEntry[] {
	if (leafId === null) return [];
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) byId.set(entry.id, entry);
	let current = byId.get(leafId) ?? entries.at(-1);
	const path: SessionEntry[] = [];
	const seen = new Set<string>();
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path.reverse();
}

function entryMessage(entry: SessionEntry, activeCompactionId: string | undefined): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			return entry.message;
		case "custom_message": {
			const content = entry.content;
			if (typeof content !== "string" && !Array.isArray(content)) return undefined;
			return {
				role: "custom",
				customType: typeof entry.customType === "string" ? entry.customType : "",
				content,
				display: entry.display !== false,
				details: entry.details,
				...(entry.attribution === undefined ? {} : { attribution: entry.attribution }),
				timestamp: entryTime(entry),
			};
		}
		case "branch_summary":
			if (typeof entry.summary !== "string" || !entry.summary) return undefined;
			return { role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp: entryTime(entry) };
		case "compaction": {
			const active = entry.id === activeCompactionId;
			return {
				role: "compactionSummary",
				summary: active && typeof entry.summary === "string" ? entry.summary : SUPERSEDED_COMPACTION_SUMMARY,
				shortSummary: active
					? typeof entry.shortSummary === "string"
						? entry.shortSummary
						: undefined
					: SUPERSEDED_COMPACTION_SHORT_SUMMARY,
				tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined,
				tokensAfter: typeof entry.tokensAfter === "number" ? entry.tokensAfter : undefined,
				method: typeof entry.method === "string" ? entry.method : undefined,
				warning: entry.warning,
				timestamp: entryTime(entry),
			};
		}
		default:
			return undefined;
	}
}

/** A snapcompact frame rescue re-records the same compaction point; only the replacement renders. */
function isSupersededSnapcompact(entry: SessionEntry, next: SessionEntry | undefined): boolean {
	return (
		next?.type === "compaction" &&
		entry.method === "snapcompact" &&
		next.method === "snapcompact" &&
		next.parentId === entry.id &&
		next.firstKeptEntryId === entry.firstKeptEntryId &&
		next.tokensBefore === entry.tokensBefore
	);
}

/**
 * Display transcript for the branch ending at `leafId`, each message carrying
 * its `entryId`. Assistant tool calls with no result on the path (failed or
 * retried turns, results on a sibling branch) are stripped and counted in
 * `strippedToolCalls`, as omp's transcript does.
 */
export function projectTranscript(entries: readonly SessionEntry[], leafId: string | null): AgentMessage[] {
	const path = branchPath(entries, leafId);
	const activeCompactionId = path.findLast(entry => entry.type === "compaction")?.id;
	const messages: AgentMessage[] = [];
	for (let index = 0; index < path.length; index++) {
		const entry = path[index];
		if (entry.type === "compaction" && isSupersededSnapcompact(entry, path[index + 1])) continue;
		const message = entryMessage(entry, activeCompactionId);
		if (message) messages.push({ ...message, entryId: entry.id });
	}

	const paired = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolCallId) paired.add(message.toolCallId);
	}
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		let stripped = 0;
		for (const block of message.content) {
			if (block.type === "toolCall" && !paired.has(block.id)) stripped++;
		}
		if (stripped === 0) continue;
		const content = message.content
			.filter(
				block =>
					!(block.type === "toolCall" && !paired.has(block.id)) && (block.type as string) !== "redactedThinking",
			)
			.map(block =>
				block.type === "thinking" && "thinkingSignature" in block
					? { ...block, thinkingSignature: undefined }
					: block,
			);
		messages[index] = { ...message, content, strippedToolCalls: stripped };
	}
	return messages;
}

/** omp's `sessionMessagePersistenceKey` (session/turn-persistence.ts): identity of a persisted message. */
function persistenceKey(message: AgentMessage): string | undefined {
	switch (message.role) {
		case "assistant":
			return [
				"assistant",
				message.timestamp,
				message.provider,
				message.model,
				message.responseId ?? "",
				message.stopReason,
			].join(":");
		case "toolResult":
			return `toolResult:${message.timestamp}:${message.toolCallId}:${message.toolName}`;
		case "user":
			return `user:${message.timestamp}:${message.attribution ?? ""}`;
		case "fileMention":
			return `fileMention:${message.timestamp}`;
		default:
			return (message.role as string) === "developer"
				? `developer:${message.timestamp}:${message.attribution ?? ""}`
				: undefined;
	}
}

function sameContent(left: AgentMessage, right: AgentMessage): boolean {
	const pick = (message: AgentMessage) => (message.role === "fileMention" ? message.files : message.content);
	return JSON.stringify(pick(left)) === JSON.stringify(pick(right));
}

/**
 * Stamp `entryId` onto live messages (e.g. `agent_end.messages`) by matching
 * them against freshly fetched `message` entries. Unmatched messages pass
 * through unchanged.
 */
export function attachEntryIds(messages: readonly AgentMessage[], entries: readonly SessionEntry[]): AgentMessage[] {
	const byKey = new Map<string, SessionEntry[]>();
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		const key = persistenceKey(entry.message);
		if (!key) continue;
		const keyed = byKey.get(key);
		if (keyed) keyed.push(entry);
		else byKey.set(key, [entry]);
	}
	return messages.map(message => {
		if (message.entryId) return message;
		const key = persistenceKey(message);
		const keyed = key ? byKey.get(key) : undefined;
		const entry =
			keyed?.length === 1
				? keyed[0]
				: keyed?.find(candidate => candidate.message && sameContent(candidate.message, message));
		return entry ? { ...message, entryId: entry.id } : message;
	});
}

/** Fetch entries after `since`; an id omp no longer knows (session switched) falls back to the full list. */
export async function fetchEntries(send: LocalCommandContext["send"], since: string | null): Promise<EntriesSnapshot> {
	if (since !== null) {
		try {
			return await send<EntriesSnapshot>({ type: "get_entries", since });
		} catch {
			// unknown_since: the cursor belongs to a previous session.
		}
	}
	return send<EntriesSnapshot>({ type: "get_entries" });
}

const TranscriptCursor = z
	.object({
		v: z.literal(1),
		leafId: z.string().nullable(),
		total: z.number().int().nonnegative(),
		offset: z.number().int().nonnegative(),
	})
	.refine(cursor => cursor.offset <= cursor.total);
type TranscriptCursor = z.infer<typeof TranscriptCursor>;

function encodeCursor(cursor: TranscriptCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: unknown): TranscriptCursor {
	try {
		if (typeof raw !== "string" || raw.length > 2048) throw new Error("not a cursor");
		return TranscriptCursor.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
	} catch {
		throw new Error("Invalid transcript cursor");
	}
}

/**
 * Projection of the first page, reused by the follow-up pages of the same walk
 * so a long transcript costs one `get_entries`, not one per page. Keyed by the
 * sidecar spawn's bridge client, which lives exactly as long as that omp process.
 */
const pagedTranscripts = new WeakMap<BridgeClient, { leafId: string | null; messages: AgentMessage[] }>();

async function transcriptSnapshot(
	ctx: LocalCommandContext,
): Promise<{ leafId: string | null; messages: AgentMessage[] }> {
	const { entries, leafId } = await ctx.send<EntriesSnapshot>({ type: "get_entries" });
	return { leafId, messages: projectTranscript(entries, leafId) };
}

function pageLimit(raw: unknown): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_PAGE_LIMIT;
	return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(raw)));
}

/** The `get_state` fields the session-changing handlers consult. */
interface RunState {
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
}

function requiredString(command: Record<string, unknown>, key: string, what: string): string {
	const value = command[key];
	if (typeof value !== "string" || !value.trim()) throw new Error(`${what} cannot be empty`);
	return value.trim();
}

export const handlers: Record<string, LocalHandler> = {
	...extraHandlers,
	get_transcript: async (_command, ctx) => ({ messages: (await transcriptSnapshot(ctx)).messages }),

	get_transcript_page: async (command, ctx): Promise<MessagesPage> => {
		const limit = pageLimit(command.limit);
		let snapshot: { leafId: string | null; messages: AgentMessage[] };
		let offset = 0;
		if (command.cursor === undefined) {
			snapshot = await transcriptSnapshot(ctx);
			pagedTranscripts.set(ctx.bridge, snapshot);
		} else {
			const cursor = decodeCursor(command.cursor);
			const cached = pagedTranscripts.get(ctx.bridge);
			if (cached && cached.leafId === cursor.leafId && cached.messages.length === cursor.total) snapshot = cached;
			else {
				// Another walk of the same spawn finished and dropped the cache (hydrations
				// overlap on tab open). Re-cache the fresh projection, or every remaining page
				// of this walk would re-fetch and re-project the whole journal.
				snapshot = await transcriptSnapshot(ctx);
				pagedTranscripts.set(ctx.bridge, snapshot);
			}
			if (snapshot.leafId !== cursor.leafId || snapshot.messages.length !== cursor.total) {
				throw new LocalCommandError("RPC message cursor is stale", "stale_cursor");
			}
			offset = cursor.offset;
		}
		const total = snapshot.messages.length;
		const end = Math.min(total, offset + limit);
		const page: MessagesPage = { messages: snapshot.messages.slice(offset, end), totalMessages: total };
		if (end < total) page.nextCursor = encodeCursor({ v: 1, leafId: snapshot.leafId, total, offset: end });
		// Only the walk that owns the cached projection releases it; a concurrent walk still paging it keeps it.
		else if (pagedTranscripts.get(ctx.bridge) === snapshot) pagedTranscripts.delete(ctx.bridge);
		return page;
	},

	/** Fork `newSession({ drop: true })`: leave for a fresh session, then delete the one left behind. */
	drop_session: async (_command, ctx) => {
		const state = await ctx.send<RunState>({ type: "get_state" });
		if (state.isStreaming || state.isCompacting) throw new Error("Cannot delete a session while it is running");
		const { cancelled } = await ctx.send<{ cancelled: boolean }>({ type: "new_session" });
		if (!cancelled && state.sessionFile) await deleteSessionFiles(state.sessionFile);
		return { cancelled };
	},

	/** Stock `switch_session`, then the explicit model a model-restore recovery asked for. */
	switch_session: async (command, ctx) => {
		const sessionPath = requiredString(command, "sessionPath", "Session path");
		const result = await ctx.send<{ cancelled: boolean }>({ type: "switch_session", sessionPath });
		const { provider, modelId } = command;
		if (!result.cancelled && typeof provider === "string" && typeof modelId === "string") {
			await ctx.send({ type: "set_model", provider, modelId });
		}
		return result;
	},

	/** The live session renames through stock; any other stored session through a short-lived omp. */
	set_session_name: async (command, ctx) => {
		const name = requiredString(command, "name", "Session name");
		const target = typeof command.sessionPath === "string" ? resolve(command.sessionPath) : undefined;
		if (target === undefined || (ctx.sessionFile !== undefined && target === resolve(ctx.sessionFile))) {
			await ctx.send({ type: "set_session_name", name });
		} else {
			await renameStoredSession(ctx.omp, target, name);
		}
		return undefined;
	},

	set_session_pinned: async (command, ctx) => {
		const sessionId = requiredString(command, "sessionId", "Session id");
		return ctx.bridge.request<{ pinned: boolean }>("sessions.set_pinned", {
			sessionId,
			pinned: command.pinned === true,
		});
	},

	set_entry_label: async (command, ctx) => {
		const entryId = requiredString(command, "entryId", "Entry id");
		await ctx.bridge.request("sessions.set_entry_label", { entryId, label: command.label });
		return undefined;
	},

	get_session_tree: async (_command, ctx): Promise<RpcSessionTreeResult> => {
		const { entries, leafId } = await ctx.send<EntriesSnapshot>({ type: "get_entries" });
		return projectSessionTree(entries, leafId);
	},

	/** `navigateTree` in the live session; a summary runs a model turn, so the bridge call has no deadline of its own. */
	switch_leaf: async (command, ctx) => {
		const entryId = requiredString(command, "entryId", "Entry id");
		const state = await ctx.send<RunState>({ type: "get_state" });
		if (state.isStreaming) throw new LocalCommandError("Session is busy (streaming)", "busy");
		return ctx.bridge.request<RpcSwitchLeafResult>("sessions.switch_leaf", {
			entryId,
			summarize: command.summarize === true,
			customInstructions: command.customInstructions,
		});
	},

	/** A new session file holding the root→entry path; the attached session stays where it is. */
	fork_from: async (command, ctx) => {
		const entryId = requiredString(command, "entryId", "Entry id");
		return ctx.bridge.request<{ sessionPath: string; sessionId: string }>("sessions.fork_from", { entryId });
	},
};
