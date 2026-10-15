/**
 * Files panel content search (C46/C47): the project's text through stock's own
 * pi-natives `grep` (the agent's search engine; .gitignore-aware, hidden files
 * skipped) in the stock helper worker. Main turns the panel's plain query,
 * Match case / Whole word / Regex and glob into one grep call and caps it.
 * Shared by the local IPC handler and the remote host. Never throws.
 */
import { z } from "zod";
import type { IpcErrorCode } from "../shared/ipc-error-codes";
import type { IpcFsSearchRequest, IpcFsSearchResult } from "../shared/ipc-types";

/** Matches a search returns; the panel says when there are more. */
export const SEARCH_MAX_MATCHES = 500;

const SearchRequestSchema = z.object({
	query: z.string().min(1).max(1000),
	matchCase: z.boolean(),
	wholeWord: z.boolean(),
	regex: z.boolean(),
	glob: z.string().max(200),
});

interface HelperResult {
	matches: { path: string; line: number; text: string }[];
	files: number;
	limited: boolean;
}

/** The grep pattern for a request: plain text is escaped, whole word wraps it in word boundaries. */
export function searchPattern(request: IpcFsSearchRequest): string {
	const body = request.regex ? request.query : request.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return request.wholeWord ? `\\b(?:${body})\\b` : body;
}

export async function searchWorkspace(
	root: string | null,
	request: unknown,
	helper: (method: string, params: unknown) => Promise<unknown>,
): Promise<IpcFsSearchResult> {
	const fail = (error: string, code?: IpcErrorCode): IpcFsSearchResult => ({
		ok: false,
		matches: [],
		files: 0,
		limited: false,
		error,
		...(code ? { code } : {}),
	});
	if (!root) return fail("No workspace", "no_workspace");
	const parsed = SearchRequestSchema.safeParse(request);
	if (!parsed.success) return fail("Invalid search", "invalid_path");
	const pattern = searchPattern(parsed.data);
	if (parsed.data.regex) {
		try {
			new RegExp(pattern);
		} catch (err) {
			return fail(err instanceof Error ? err.message : String(err), "invalid_regex");
		}
	}
	try {
		const result = (await helper("search.text", {
			root,
			pattern,
			ignoreCase: !parsed.data.matchCase,
			glob: parsed.data.glob.trim() || undefined,
			maxCount: SEARCH_MAX_MATCHES,
		})) as HelperResult;
		return { ok: true, matches: result.matches, files: result.files, limited: result.limited };
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
}
