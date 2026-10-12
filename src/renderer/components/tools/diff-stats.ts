import { resultDetails, resultText } from "../../lib/format";
import { xdevWriteTarget } from "../../lib/xdev";
import { parseChangeGroups } from "./AstEditRenderer";

export interface DiffStats {
	added: number;
	removed: number;
}

/** Added/removed line counts of a unified diff. Header lines (`+++ b/x`)
 * exist only before their file's first hunk — after that, `--- disabled` and
 * `+++i` are removed/added source lines, not headers to skip. */
export function unifiedDiffStats(diff: string): DiffStats {
	let added = 0;
	let removed = 0;
	let sawHunk = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("@@")) {
			sawHunk = true;
			continue;
		}
		if (!sawHunk && /^(---|\+\+\+) \S/.test(line)) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** Lines of written content; a final newline ends the last line rather than starting another. */
export function lineCount(text: string): number {
	if (!text) return 0;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

function sum(parts: DiffStats[]): DiffStats | null {
	if (parts.length === 0) return null;
	return parts.reduce((total, part) => ({ added: total.added + part.added, removed: total.removed + part.removed }), {
		added: 0,
		removed: 0,
	});
}

/** Result-side diffs: one `details.diff`, or one per file of a multi-file edit. */
function resultDiffStats(details: Record<string, unknown> | undefined): DiffStats | null {
	if (!details) return null;
	if (Array.isArray(details.perFileResults)) {
		const parts: DiffStats[] = [];
		for (const entry of details.perFileResults) {
			const diff = entry != null && typeof entry === "object" ? (entry as Record<string, unknown>).diff : undefined;
			if (typeof diff === "string" && diff) parts.push(unifiedDiffStats(diff));
		}
		if (parts.length > 0) return sum(parts);
	}
	return typeof details.diff === "string" && details.diff ? unifiedDiffStats(details.diff) : null;
}

/** Replace-mode edit args (`old_text`/`new_text`, per edit or top level): every old line goes, every new line comes. */
function oldNewArgStats(args: Record<string, unknown>): DiffStats | null {
	const pairs = Array.isArray(args.edits) ? args.edits : [args];
	const parts: DiffStats[] = [];
	for (const pair of pairs) {
		if (pair == null || typeof pair !== "object") continue;
		const record = pair as Record<string, unknown>;
		const oldText = record.old_text ?? record.oldText ?? record.old_string;
		const newText = record.new_text ?? record.newText ?? record.new_string;
		if (typeof oldText !== "string" && typeof newText !== "string") continue;
		parts.push({
			added: typeof newText === "string" ? lineCount(newText) : 0,
			removed: typeof oldText === "string" ? lineCount(oldText) : 0,
		});
	}
	return sum(parts);
}

/** `*** Begin Patch` input (apply_patch): count body lines, skipping the `***` envelope. */
function patchInputStats(input: string): DiffStats | null {
	if (!input.includes("*** Begin Patch")) return null;
	return unifiedDiffStats(input.replace(/^\*\*\*.*$/gm, ""));
}

/**
 * `+N −M` for the collapsed row of a file-changing call. The result's diff is
 * authoritative; while the call runs (or for legacy history) the arguments
 * stand in where they say exactly what changes. Null when nothing honest can
 * be said — a device call, an overwrite without a captured diff, a failure.
 */
export function toolDiffStats(
	toolName: string,
	args: Record<string, unknown>,
	result: unknown,
	isError: boolean,
): DiffStats | null {
	if (isError) return null;
	const details = resultDetails(result);
	switch (toolName) {
		case "edit":
		case "apply_patch": {
			const fromResult = resultDiffStats(details);
			if (fromResult) return fromResult;
			if (details) return null;
			const input = typeof args.input === "string" ? args.input : typeof args._input === "string" ? args._input : "";
			return oldNewArgStats(args) ?? (input ? patchInputStats(input) : null);
		}
		case "write": {
			if (xdevWriteTarget(args)) return null;
			const path = typeof args.path === "string" ? args.path : "";
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
			const fromResult = resultDiffStats(details);
			if (fromResult) return fromResult;
			if (details?.overwritten === true || typeof args.content !== "string") return null;
			return { added: lineCount(args.content), removed: 0 };
		}
		case "ast_edit": {
			const text = typeof details?.displayContent === "string" ? details.displayContent : resultText(result);
			const parts: DiffStats[] = [];
			for (const group of parseChangeGroups(text)) {
				for (const row of group.rows) {
					if (row.type === "add") parts.push({ added: 1, removed: 0 });
					else if (row.type === "remove") parts.push({ added: 0, removed: 1 });
				}
			}
			return sum(parts);
		}
		default:
			return null;
	}
}
