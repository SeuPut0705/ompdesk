/** GUI transcript pagination and session commands; stock replay and indexed tree projection run in the bridge. */
import { resolve } from "node:path";
import { z } from "zod";
import type {
	AgentMessage,
	MessagesPage,
	RpcForkFromResult,
	RpcSessionTreeResult,
	RpcSwitchLeafResult,
} from "../../shared/rpc-types";
import { handlers as extraHandlers } from "./session-extras";
import { renameStoredSession } from "./session-files";
import { type LocalCommandContext, LocalCommandError, type LocalHandler } from "./types";

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 256;

const TranscriptCursor = z
	.object({
		v: z.literal(1),
		leafId: z.string().nullable(),
		total: z.number().int().nonnegative(),
		offset: z.number().int().nonnegative(),
		backward: z.boolean().optional(),
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

interface TranscriptPage {
	leafId: string | null;
	total: number;
	messages: AgentMessage[];
	startIndex?: number;
}

/**
 * One page of the bridge's cached stock replay. Pages, never the whole
 * transcript: the bridge socket answers in order, so one multi-MB reply would
 * stall every other bridge request (history, compaction, completions) behind it.
 */
function transcriptPage(
	ctx: LocalCommandContext,
	offset: number,
	limit: number,
	snapToTurn = false,
): Promise<TranscriptPage> {
	return ctx.bridge.request("sessions.transcript", { offset, limit, ...(snapToTurn ? { snapToTurn } : {}) });
}

function pageLimit(raw: unknown): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_PAGE_LIMIT;
	return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(raw)));
}

/** The `get_state` field the session-changing handlers consult. */
interface RunState {
	isStreaming: boolean;
}

function requiredString(command: Record<string, unknown>, key: string, what: string): string {
	const value = command[key];
	if (typeof value !== "string" || !value.trim()) throw new Error(`${what} cannot be empty`);
	return value.trim();
}

export const handlers: Record<string, LocalHandler> = {
	...extraHandlers,
	get_transcript: async (_command, ctx) => {
		const first = await transcriptPage(ctx, 0, MAX_PAGE_LIMIT);
		const messages = [...first.messages];
		while (messages.length < first.total) {
			const page = await transcriptPage(ctx, messages.length, MAX_PAGE_LIMIT);
			if (page.leafId !== first.leafId || page.total !== first.total || page.messages.length === 0) {
				throw new LocalCommandError("Transcript changed while it was read", "stale_cursor");
			}
			messages.push(...page.messages);
		}
		return { messages };
	},

	get_transcript_page: async (command, ctx): Promise<MessagesPage> => {
		const limit = pageLimit(command.limit);
		const cursor = command.cursor === undefined ? undefined : decodeCursor(command.cursor);
		const backward = command.fromEnd === true || cursor?.backward === true;
		const metadata = backward && !cursor ? await transcriptPage(ctx, 0, 0) : undefined;
		const endIndex = cursor?.offset ?? metadata?.total ?? limit;
		const offset = backward ? Math.max(0, endIndex - limit) : (cursor?.offset ?? 0);
		const page = await transcriptPage(ctx, offset, backward ? endIndex - offset : limit, backward);
		if (
			(cursor && (page.leafId !== cursor.leafId || page.total !== cursor.total)) ||
			(metadata && (page.leafId !== metadata.leafId || page.total !== metadata.total))
		) {
			throw new LocalCommandError("RPC message cursor is stale", "stale_cursor");
		}
		const startIndex = page.startIndex ?? offset;
		const end = startIndex + page.messages.length;
		const result: MessagesPage = { messages: page.messages, totalMessages: page.total, startIndex };
		if (backward && startIndex > 0) {
			result.prevCursor = encodeCursor({
				v: 1,
				leafId: page.leafId,
				total: page.total,
				offset: startIndex,
				backward: true,
			});
		} else if (!backward && end < page.total) {
			result.nextCursor = encodeCursor({ v: 1, leafId: page.leafId, total: page.total, offset: end });
		}
		return result;
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

	/**
	 * A new session file holding the root→entry path; the attached session stays where it is. From a prompt the
	 * copy ends before it and the prompt comes back as `draft` (resources/gui-bridge/session-fork-core.ts).
	 */
	fork_from: async (command, ctx) => {
		const entryId = requiredString(command, "entryId", "Entry id");
		return ctx.bridge.request<RpcForkFromResult>("sessions.fork_from", { entryId });
	},
};
