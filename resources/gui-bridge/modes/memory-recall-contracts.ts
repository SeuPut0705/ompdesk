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

/**
 * The term corpus main keeps beside the state file (`recall.json`): `{v: 1, store, native, synced, n, df}`, the document
 * frequencies of conclusion terms the code rule's coverage gate reads (src/main/ai-memory/recall-terms.ts).
 */
export const RECALL_TERMS_FILE = "recall-terms.json";

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
 * Probability of "this snippet holds what the prompt needs" from which the judge keeps a candidate. Chosen 20 Oct 2026
 * on the user's real data (time-filtered store copies; Jev 1.14): 0.5 put the answer in 7/11 against 5/11 at 0.6. With
 * session pages out of the candidates, the replay's 12 typed prompts with nothing to recall got no false injection at
 * 0.5 (answer present 5/9 typed prompts). n is small, so measure again as data grows.
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
	| "conclusion";

/** One note the model was given, as the transcript line names it. */
export interface MemoryRecallItem {
	title: string;
	kind: MemoryRecallKind;
	/** A page's path in its project's wiki. */
	path?: string;
	/** The page version's id (the server's `PageId`): an edited page has a new one. */
	version?: string;
	/** A conclusion's session. */
	sessionId?: string;
	/** When it was recorded (ISO-8601), when the server says. */
	at?: string;
	/** The project the page was read from (`_global` for a standing preference). */
	scope?: { workspace: string; project: string };
}

export interface MemoryRecallDetails {
	v: 1;
	items: MemoryRecallItem[];
	/** Whether the judge chose the items (else the code rule did). */
	judged: boolean;
	/** The project the notes were read from: where the transcript opens a page or rates it. Absent on older messages. */
	scope?: { workspace: string; project: string };
}

const KINDS: Record<MemoryRecallKind, true> = {
	decision: true,
	rule: true,
	gotcha: true,
	procedure: true,
	preference: true,
	profile: true,
	note: true,
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
		for (const key of ["path", "version", "sessionId", "at"] as const) {
			const value = Reflect.get(entry, key);
			if (typeof value === "string" && value) item[key] = value;
		}
		const own = Reflect.get(entry, "scope");
		const ws = own !== null && typeof own === "object" ? Reflect.get(own, "workspace") : undefined;
		const pr = own !== null && typeof own === "object" ? Reflect.get(own, "project") : undefined;
		if (typeof ws === "string" && ws && typeof pr === "string" && pr) item.scope = { workspace: ws, project: pr };
		items.push(item);
	}
	const scope = Reflect.get(details, "scope");
	const workspace = scope !== null && typeof scope === "object" ? Reflect.get(scope, "workspace") : undefined;
	const project = scope !== null && typeof scope === "object" ? Reflect.get(scope, "project") : undefined;
	return items.length
		? {
				v: 1,
				items,
				judged: Reflect.get(details, "judged") === true,
				...(typeof workspace === "string" && workspace && typeof project === "string" && project
					? { scope: { workspace, project } }
					: {}),
			}
		: undefined;
}

// The text format of `recallText` (memory-recall-core.ts) and its inverse live together here, so the renderer reads
// it without pulling in the selection rules.
/** The kind words `recallText` writes in each note's heading (the model's text; the transcript has its own). */
export const KIND_LABEL: Record<MemoryRecallKind, string> = {
	decision: "Decision",
	rule: "Rule",
	gotcha: "Gotcha",
	procedure: "Procedure",
	preference: "Preference",
	profile: "Profile",
	note: "Note",
	conclusion: "Earlier conclusion",
};

export const RECALL_OPEN = "<memory-recall>";
export const RECALL_CLOSE = "</memory-recall>";

/** One note of a recall message's text, as `recallText` wrote it. */
export interface RecallTextNote {
	kind: MemoryRecallKind;
	/** The heading after the kind: `title`, or `title · path-or-date`. */
	heading: string;
	/** The note's text as the model received it (cut to its budget, `<`/`>` made inert); empty when none fit. */
	text: string;
}

const KIND_BY_LABEL = new Map<string, MemoryRecallKind>(
	(Object.entries(KIND_LABEL) as [MemoryRecallKind, string][]).map(([kind, label]) => [label, kind]),
);

/**
 * The notes inside a `recallText` block, in order: the inverse of `recallText`, so the transcript can show what the
 * model received without the bridge repeating it in the message's details. Headings are numbered 1..n and a note's
 * text runs to the next heading in sequence, so a note line that itself starts like a heading does not split it.
 * Anything that is not such a block gives an empty list.
 */
export function parseRecallText(content: string): RecallTextNote[] {
	const start = content.indexOf(RECALL_OPEN);
	const end = content.indexOf(RECALL_CLOSE, start + 1);
	if (start < 0 || end < 0) return [];
	const lines = content.slice(start + RECALL_OPEN.length, end).split("\n");
	const notes: { kind: MemoryRecallKind; heading: string; lines: string[] }[] = [];
	for (const line of lines) {
		const match = /^(\d+)\. (.+?) · (.*)$/.exec(line);
		const kind = match ? KIND_BY_LABEL.get(match[2]) : undefined;
		if (match && kind && Number(match[1]) === notes.length + 1) {
			notes.push({ kind, heading: match[3], lines: [] });
		} else if (notes.length) {
			notes[notes.length - 1].lines.push(line);
		}
	}
	return notes.map(note => ({ kind: note.kind, heading: note.heading, text: note.lines.join("\n").trim() }));
}
