/**
 * Memory recall: before a prompt a person typed in a main session, the bridge asks the local memory server
 * (`memory_query` over MCP) for earlier decisions and session conclusions that bear on it, keeps at most three, and
 * hands them to the model as one custom message the transcript shows as a quiet line (`MemoryRecallNote`).
 * Dependency-free: main (the spawn env), the bridge (modes/memory-recall*.ts) and the renderer import it.
 */

/**
 * Spawn env: the path of a small JSON file `{url, dataDir}` main keeps current while memory is on
 * (src/main/ai-memory/recall-state.ts) and deletes when it is off. A file, not the values themselves: a tab's omp
 * starts before memory's setup pass has learned the data dir (it runs after the first tab), and the switch may change
 * while the omp runs; the bridge reads the file at each prompt.
 */
export const MEMORY_ENV = "OMP_GUI_MEMORY";

export interface MemoryEnv {
	/** The local server's base URL (`http://127.0.0.1:<port>`). */
	url: string;
	/** Its data dir: the bearer token is `<dataDir>/auth-tokens/default`, read at call time. */
	dataDir: string;
}

/** The state file's content, or undefined for anything else (memory off, a half-written file). */
export function parseMemoryEnv(raw: string | undefined): MemoryEnv | undefined {
	if (!raw) return undefined;
	try {
		const value: unknown = JSON.parse(raw);
		if (value === null || typeof value !== "object") return undefined;
		const url = Reflect.get(value, "url");
		const dataDir = Reflect.get(value, "dataDir");
		return typeof url === "string" && url && typeof dataDir === "string" && dataDir
			? { url: url.replace(/\/+$/, ""), dataDir }
			: undefined;
	} catch {
		return undefined;
	}
}

/** `customType` of the recall message (the renderer's `MemoryRecallNote`). */
export const MEMORY_RECALL_MESSAGE_TYPE = "ompdesk-memory-recall";

/** Judgment purpose in the session's usage ledger. */
export const MEMORY_RECALL_PURPOSE = "ompdesk-memory-recall";

/** `memory_query`'s `limit`: page hits and (separately) conclusion hits. */
export const RECALL_QUERY_LIMIT = 8;

/** At most this many notes reach the model. */
export const RECALL_MAX_ITEMS = 3;

/** The whole server round trip; past it the prompt goes on with nothing recalled. Measured p95 6.7 ms. */
export const RECALL_TIMEOUT_MS = 600;

/** The model text's ceiling (estimated tokens, see `estimateTokens` in memory-recall-core.ts). */
export const RECALL_MAX_TOKENS = 600;

/**
 * Probability of "this snippet holds what the prompt needs" from which the judge keeps a candidate. Measured 20 Oct
 * 2026 on the user's real data (16 prompts: 11 answerable, 5 negative controls; time-filtered store copies; Jev 1.14):
 * 0.5 put the answer in 7/11 with 3/5 false injections, 0.6 in 5/11 with 2/5, 0.4 in 7/11 with 4/5, 0.7 in 5/11 with
 * 2/5 (fewer found). 0.5 buys two answers for one false injection; n is small, so measure again as data grows.
 */
export const RECALL_JUDGE_MIN = 0.5;

export type MemoryRecallKind =
	| "decision"
	| "rule"
	| "gotcha"
	| "procedure"
	| "preference"
	| "profile"
	| "note"
	| "session"
	| "conclusion";

/** One note the model was given, as the transcript line names it. */
export interface MemoryRecallItem {
	title: string;
	kind: MemoryRecallKind;
	/** A page's path in its project's wiki. */
	path?: string;
	/** A conclusion's (or session page's) session. */
	sessionId?: string;
	/** When it was recorded (ISO-8601), when the server says. */
	at?: string;
}

export interface MemoryRecallDetails {
	v: 1;
	items: MemoryRecallItem[];
	/** Whether the judge chose the items (else the code rule did). */
	judged: boolean;
}

const KINDS: Record<MemoryRecallKind, true> = {
	decision: true,
	rule: true,
	gotcha: true,
	procedure: true,
	preference: true,
	profile: true,
	note: true,
	session: true,
	conclusion: true,
};

/** The recall message's `details`, or undefined for anything else (an unknown version included). */
export function memoryRecallDetails(details: unknown): MemoryRecallDetails | undefined {
	if (details === null || typeof details !== "object" || Reflect.get(details, "v") !== 1) return undefined;
	const raw = Reflect.get(details, "items");
	if (!Array.isArray(raw)) return undefined;
	const items: MemoryRecallItem[] = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object") continue;
		const title = Reflect.get(entry, "title");
		const kind = Reflect.get(entry, "kind");
		if (typeof title !== "string" || !title || typeof kind !== "string" || !Object.hasOwn(KINDS, kind)) continue;
		const item: MemoryRecallItem = { title, kind: kind as MemoryRecallKind };
		for (const key of ["path", "sessionId", "at"] as const) {
			const value = Reflect.get(entry, key);
			if (typeof value === "string" && value) item[key] = value;
		}
		items.push(item);
	}
	return items.length ? { v: 1, items, judged: Reflect.get(details, "judged") === true } : undefined;
}
