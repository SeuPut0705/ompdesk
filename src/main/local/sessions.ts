/** GUI transcript pagination and session commands; stock replay and indexed tree projection run in the bridge. */
import { resolve } from "node:path";
import { z } from "zod";
import type { AgentMessage, MessagesPage, RpcSessionTreeResult, RpcSwitchLeafResult } from "../../shared/rpc-types";
import { handlers as extraHandlers } from "./session-extras";
import { renameStoredSession } from "./session-files";
import { type BridgeClient, type LocalCommandContext, LocalCommandError, type LocalHandler } from "./types";

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 256;

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
 * so a long transcript costs one bridge projection, not one per page. Keyed by the
 * sidecar spawn's bridge client, which lives exactly as long as that omp process.
 */
const pagedTranscripts = new WeakMap<BridgeClient, { leafId: string | null; messages: AgentMessage[] }>();

async function transcriptSnapshot(
	ctx: LocalCommandContext,
): Promise<{ leafId: string | null; messages: AgentMessage[] }> {
	return ctx.bridge.request("sessions.transcript");
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
		if (!cancelled && state.sessionFile) {
			await ctx.bridge.request("sessions.delete", { sessionPath: state.sessionFile });
		}
		return { cancelled };
	},

	/**
	 * Stock `switch_session` with the explicit model a model-restore recovery asked
	 * for; stock binds it in the switch, which otherwise refuses a session whose
	 * saved model cannot be restored.
	 */
	switch_session: async (command, ctx) => {
		const sessionPath = requiredString(command, "sessionPath", "Session path");
		const { provider, modelId } = command;
		const model = typeof provider === "string" && typeof modelId === "string" ? { provider, modelId } : undefined;
		return ctx.send<{ cancelled: boolean }>({ type: "switch_session", sessionPath, ...model });
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
		return ctx.bridge.request("sessions.tree");
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
