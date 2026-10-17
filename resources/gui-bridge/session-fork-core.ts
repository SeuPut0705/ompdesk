/**
 * Where "Branch from here" (`sessions.fork_from`) ends its copy. Dependency-free.
 *
 * A copy must never end on something nothing will ever answer: stock reads such a tail as a turn its process
 * never finished (exit-diagnostics.ts `findUnfinishedTurn`), so the next omp that opens it journals "Previous
 * OMP process exited before completing the turn." (and the interrupted tool results) and a restore would run it.
 *
 * - From a user prompt the copy ends before it and the prompt comes back as a draft, the way stock `branch`
 *   (agent-session.ts) leaves the leaf on the prompt's parent and restores its text and pictures into the editor.
 * - Inside an assistant tool-call batch the copy is extended through the recorded results that answer it, as
 *   stock `fork(entryId)` does (`#resolveForkLeaf`, private there); a batch with a call still awaiting its
 *   result is cut before that batch's assistant message.
 * - Anything else is kept as it is.
 */

interface ImagePart {
	type: "image";
	data: string;
	mimeType: string;
}

interface ToolCallPart {
	type: "toolCall";
	id: string;
}

/** The fields of a stock `SessionEntry` the rule reads. */
export interface ForkEntry {
	id: string;
	type: string;
	parentId: string | null;
	message?: { role?: string; content?: unknown; toolCallId?: string };
}

/** The source session's tree, as stock `SessionManager` exposes it (`getEntry`, `getBranch`, `getChildren`). */
export interface ForkTree {
	entry(id: string): ForkEntry | undefined;
	/** Root → `id`, inclusive. */
	path(id: string): readonly ForkEntry[];
	children(id: string): readonly ForkEntry[];
}

export interface ForkCut {
	/** The last entry the new session keeps. */
	leafId: string;
	/** The prompt the copy stops before, for the new session's composer. */
	draft?: { text: string; images: ImagePart[] };
}

function promptText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	// Stock's own `#extractUserMessageText`: the text parts, joined as they are.
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map(part => part.text)
		.join("");
}

function promptImages(content: unknown): ImagePart[] {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(part): part is ImagePart =>
			part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string",
	);
}

function toolCallIds(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((part): part is ToolCallPart => part?.type === "toolCall" && typeof part.id === "string")
		.map(part => part.id);
}

const isToolResult = (entry: ForkEntry): boolean => entry.type === "message" && entry.message?.role === "toolResult";

/**
 * The batch `entryId` sits in (its assistant message and the results recorded on the path through `entryId`),
 * extended forward through recorded results like stock `#resolveForkLeaf`; null when a call stays unanswered.
 */
function batchLeaf(tree: ForkTree, entryId: string): { leafId: string } | { unresolvedAt: ForkEntry } {
	const answered = new Set<string>();
	let batch: ForkEntry | undefined;
	const path = tree.path(entryId);
	for (let index = path.length - 1; index >= 0; index--) {
		const entry = path[index];
		if (entry?.type !== "message") continue;
		if (isToolResult(entry)) {
			if (entry.message?.toolCallId) answered.add(entry.message.toolCallId);
			continue;
		}
		if (entry.message?.role === "assistant") batch = entry;
		break;
	}
	const pending = new Set(toolCallIds(batch?.message?.content).filter(id => !answered.has(id)));
	let leafId = entryId;
	let cursor = entryId;
	while (pending.size > 0) {
		const children = tree.children(cursor);
		const result = children.findLast(
			child =>
				isToolResult(child) && child.message?.toolCallId !== undefined && pending.has(child.message.toolCallId),
		);
		if (result?.message?.toolCallId) {
			pending.delete(result.message.toolCallId);
			leafId = cursor = result.id;
			continue;
		}
		// Step over a lone bookkeeping entry; any message or fork in the tree ends the batch.
		const only = children.length === 1 ? children[0] : undefined;
		if (!only || only.type === "message") break;
		cursor = only.id;
	}
	return pending.size > 0 && batch ? { unresolvedAt: batch } : { leafId };
}

export function forkCut(tree: ForkTree, entryId: string): ForkCut {
	const entry = tree.entry(entryId);
	if (!entry) throw new Error(`Entry ${entryId} not found`);
	// Stock writes the session's model and thinking level before its first prompt, so a prompt always has a parent.
	const parentOf = (start: ForkEntry): string => {
		if (start.parentId === null) throw new Error("Nothing comes before this point: start a new session instead");
		return start.parentId;
	};
	if (entry.type === "message" && entry.message?.role === "user") {
		const content = entry.message.content;
		return { leafId: parentOf(entry), draft: { text: promptText(content), images: promptImages(content) } };
	}
	if (entry.type !== "message") return { leafId: entryId };
	const batch = batchLeaf(tree, entryId);
	return "leafId" in batch ? batch : { leafId: parentOf(batch.unresolvedAt) };
}
