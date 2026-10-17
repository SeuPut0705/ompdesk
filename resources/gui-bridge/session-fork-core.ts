/**
 * Where "Branch from here" (`sessions.fork_from`) ends its copy. Dependency-free.
 *
 * Through a reply or any other entry the copy keeps that entry. From a user prompt it ends before the
 * prompt and hands the prompt back as a draft, the way stock `branch` (agent-session.ts) leaves the leaf
 * on the prompt's parent and restores its text and pictures into the editor. A copy that ended on the
 * prompt would hold a prompt nothing ever sends: stock reads that tail as a turn its process never
 * finished (exit-diagnostics.ts `findUnfinishedTurn`), so the next omp that opens it journals "Previous
 * OMP process exited before completing the turn." and a restore would run it.
 */

interface ImagePart {
	type: "image";
	data: string;
	mimeType: string;
}

/** The fields of a stock `SessionEntry` the rule reads. */
export interface ForkEntry {
	type: string;
	parentId: string | null;
	message?: { role?: string; content?: unknown };
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

export function forkCut(entry: ForkEntry | undefined, entryId: string): ForkCut {
	if (!entry) throw new Error(`Entry ${entryId} not found`);
	if (entry.type !== "message" || entry.message?.role !== "user") return { leafId: entryId };
	// Stock writes the session's model and thinking level before its first prompt, so a prompt always has a parent.
	if (entry.parentId === null) throw new Error("Nothing comes before this prompt: start a new session instead");
	const content = entry.message.content;
	return { leafId: entry.parentId, draft: { text: promptText(content), images: promptImages(content) } };
}
