/**
 * Three measured wastes of agent sessions (rules; wiring: waste-guards.ts; `.omp/rules/waste-guards.md`).
 *
 * 1. A `bash` service start whose `ready.log` can never match. Stock watches the service's output for the pattern, and a
 *    command whose stdout goes to a file shows none of it: the call waited the whole `ready.timeout` (5 calls, 55 min in
 *    one session, `> file 2>&1` with `ready.log` and 600 to 900 s).
 * 2. Polling: a look at a job (sleep then check, `gh run`, `pgrep`, `tail -f`, `read proc://`) that a backgrounded job or
 *    a schedule delivers by itself. One non-blocking hint per kind and process.
 * 3. An `edit` the tool refused for anchoring to lines the latest read never showed, or a tag the session never got
 *    (36 errors in 14 days, all agent misuse). One non-blocking hint per process.
 *
 * No omp imports: the GUI's vitest runs it (src/main/bridge-waste-guards.test.ts).
 */

export const READY_LOG_REASON =
	"OMPdesk: ready.log can never match — the command sends its stdout to a file, so the log line is never seen and the call would wait the whole ready.timeout (measured 55 min lost in one session). Run it with async: true and `wait`, or keep stdout visible (`| tee file`).";

export const POLL_HINT =
	"OMPdesk: this polled. A backgrounded job (async: true, or a bash that outlives 60 s) delivers its result by itself; `wait` blocks until then; for a CI run `gh run watch` under async, or ompdesk_schedule {on: github}. Each look costs a model call.";

export const EDIT_HINT =
	"OMPdesk: this edit was refused. Edit only lines shown by the latest read of that file; after a grep hit or an elided or declarations-only read, read the exact range first. Copy the `[FILE#TAG]` from that read or the last edit's response, never invent one; after each edit use the tags and line numbers its response returns.";

type Token =
	| { kind: "word"; text: string }
	| { kind: "redir"; fd: number; op: ">" | ">>" | ">|" | ">&" | "&>"; target: string };

interface Scan {
	/** Tokens of the last non-empty command, in its last pipeline stage. */
	last: Token[];
	/** Source ranges of heredoc bodies (and their terminator lines). */
	bodies: Array<[number, number]>;
}

const WORD_STOP = new Set([" ", "\t", "\r", "\n", ";", "&", "|", "<", ">", "(", ")"]);

/** Index after the `)` matching the `(` at `from` (quotes and escapes skipped); the end when unclosed. */
function skipBalanced(src: string, from: number): number {
	let depth = 0;
	for (let i = from; i < src.length; i++) {
		const c = src[i];
		if (c === "\\") i++;
		else if (c === "'") i = closing(src, i, "'");
		else if (c === '"') i = closing(src, i, '"');
		else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i + 1;
	}
	return src.length;
}

/** Index of the quote that closes the one at `from` (a backslash escapes inside double quotes only). */
function closing(src: string, from: number, quote: string): number {
	for (let i = from + 1; i < src.length; i++) {
		if (quote === '"' && src[i] === "\\") i++;
		else if (src[i] === quote) return i;
	}
	return src.length;
}

/**
 * Reads a shell command into the pieces the rules need. Not a shell: quotes, escapes, `$(…)`, backticks, comments,
 * heredocs, `;`/`&&`/`||`/`&`/newline and pipes, and the redirections of the last stage. Anything it cannot place
 * (subshell contents, expansions) stays opaque, so an unclear command reads as "no redirect" and passes.
 */
function scan(src: string): Scan {
	const bodies: Array<[number, number]> = [];
	const pending: Array<{ delim: string; strip: boolean }> = [];
	const n = src.length;
	let last: Token[] = [];
	let cur: Token[] = [];
	let i = 0;

	const endCommand = () => {
		if (cur.length > 0) last = cur;
		cur = [];
	};

	/** One word from `i` to the next unquoted separator; `plain` says nothing in it was quoted or expanded. */
	const readWord = (): { text: string; plain: boolean } => {
		let text = "";
		let plain = true;
		while (i < n && !WORD_STOP.has(src[i] as string)) {
			const c = src[i] as string;
			if (c === "\\") {
				plain = false;
				if (src[i + 1] === "\n") i += 2;
				else {
					text += src[i + 1] ?? "";
					i += 2;
				}
			} else if (c === "'" || c === '"') {
				plain = false;
				const end = closing(src, i, c);
				text += src.slice(i + 1, end);
				i = end + 1;
			} else if (c === "$" && src[i + 1] === "(") {
				plain = false;
				const end = skipBalanced(src, i + 1);
				text += src.slice(i, end);
				i = end;
			} else if (c === "`") {
				plain = false;
				const end = closing(src, i, "`");
				text += src.slice(i, end + 1);
				i = end + 1;
			} else {
				text += c;
				i++;
			}
		}
		return { text, plain };
	};

	const skipBlanks = () => {
		while (src[i] === " " || src[i] === "\t") i++;
	};

	/** `i` is at `>` or at the `&` of `&>`. */
	const redirect = (fd: number) => {
		let op: Extract<Token, { kind: "redir" }>["op"];
		if (src[i] === "&") {
			i += 2;
			if (src[i] === ">") i++;
			op = "&>";
		} else {
			i++;
			if (src[i] === ">") {
				i++;
				op = ">>";
			} else if (src[i] === "&") {
				i++;
				op = ">&";
			} else if (src[i] === "|") {
				i++;
				op = ">|";
			} else op = ">";
		}
		skipBlanks();
		let target: string;
		if (src[i] === "(") {
			i = skipBalanced(src, i);
			target = "(process substitution)";
		} else target = readWord().text;
		cur.push({ kind: "redir", fd, op, target });
	};

	const readHeredocBodies = () => {
		for (const { delim, strip } of pending.splice(0)) {
			const start = i;
			while (i < n) {
				const end = src.indexOf("\n", i);
				const line = src.slice(i, end === -1 ? n : end);
				i = end === -1 ? n : end + 1;
				if ((strip ? line.replace(/^\t+/, "") : line) === delim) break;
			}
			bodies.push([start, i]);
		}
	};

	while (i < n) {
		const c = src[i] as string;
		if (c === " " || c === "\t" || c === "\r") i++;
		else if (c === "\\" && src[i + 1] === "\n") i += 2;
		else if (c === "\n") {
			i++;
			endCommand();
			readHeredocBodies();
		} else if (c === "#") {
			while (i < n && src[i] !== "\n") i++;
		} else if (c === ";") {
			i += src[i + 1] === ";" ? 2 : 1;
			endCommand();
		} else if (c === "&" && src[i + 1] === ">") redirect(1);
		else if (c === "&") {
			i += src[i + 1] === "&" ? 2 : 1;
			endCommand();
		} else if (c === "|") {
			if (src[i + 1] === "|") {
				i += 2;
				endCommand();
			} else {
				i += src[i + 1] === "&" ? 2 : 1;
				cur = [];
			}
		} else if (c === "(") {
			i = skipBalanced(src, i);
			cur.push({ kind: "word", text: "(subshell)" });
		} else if (c === ")") i++;
		else if (c === "<") {
			if (src.startsWith("<<<", i)) {
				i += 3;
				skipBlanks();
				readWord();
			} else if (src.startsWith("<<", i)) {
				i += 2;
				const strip = src[i] === "-";
				if (strip) i++;
				skipBlanks();
				const delim = readWord().text;
				if (delim) pending.push({ delim, strip });
			} else if (src[i + 1] === "(") i = skipBalanced(src, i + 1);
			else {
				i++;
				skipBlanks();
				readWord();
			}
		} else if (c === ">") redirect(1);
		else {
			const word = readWord();
			if (word.plain && /^\d+$/.test(word.text) && src[i] === ">") redirect(Number(word.text));
			else cur.push({ kind: "word", text: word.text });
		}
	}
	endCommand();
	return { last, bodies };
}

/** `command` without its heredoc bodies: what a script writes is not what the call runs. */
function withoutHeredocs(command: string): string {
	let out = "";
	let from = 0;
	for (const [start, end] of scan(command).bodies) {
		out += command.slice(from, start);
		from = end;
	}
	return out + command.slice(from);
}

/** What the call's shell shows of an output fd: the page of the tool, or a file (`/dev/null` and a closed fd included). */
type Sink = "visible" | "file";

const VISIBLE_TARGETS = /^(?:\/dev\/(?:stdout|stderr|tty|fd\/\d+)|\/proc\/self\/fd\/\d+|\(process substitution\))$/;

function sinkOf(target: string): Sink {
	return VISIBLE_TARGETS.test(target) ? "visible" : "file";
}

/** Walks the redirections in order, as the shell does (`2>&1 > f` and `> f 2>&1` differ), and says where fd 1 ends up. */
function stdoutToFile(tokens: readonly Token[]): boolean {
	const state: Record<number, Sink> = { 1: "visible", 2: "visible" };
	for (const token of tokens) {
		if (token.kind !== "redir") continue;
		const { fd, op, target } = token;
		if (op === "&>") state[1] = state[2] = sinkOf(target);
		else if (op === ">&") {
			if (fd !== 1 && fd !== 2) continue;
			if (/^\d+$/.test(target)) state[fd] = state[Number(target)] ?? "visible";
			else if (target === "-") state[fd] = "file";
			else if (fd === 1) state[1] = state[2] = sinkOf(target);
			else state[2] = sinkOf(target);
		} else if (fd === 1 || fd === 2) state[fd] = sinkOf(target);
	}
	return state[1] === "file";
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/**
 * True for a `bash` call stock would hold for `ready.log` (a named service: stock ignores `ready` without a `name`)
 * whose last command, in its last pipeline stage, sends stdout to a file. `2> file` alone, `| tee file` and a heredoc
 * body that merely mentions a redirect do not count.
 */
export function readyLogCannotMatch(input: Record<string, unknown>): boolean {
	const { ready, name, command } = input;
	if (!ready || typeof ready !== "object" || !("log" in ready) || !text(ready.log)) return false;
	if (!text(name)) return false;
	return typeof command === "string" && stdoutToFile(scan(command).last);
}

export type PollKind = "sleep" | "gh-run" | "pgrep" | "tail-f" | "proc";

const SLEEP_THEN_COMMAND = /\bsleep\s+[\d.]+[smhd]?\s*(?:;|&&|\|\||\||&|\n)\s*\S/;
const WHILE_SLEEP = /\bwhile\b[\s\S]*\bsleep\b/;
const GH_RUN = /\bgh\s+run\s+(list|view|watch)\b/;
const PGREP = /\bpgrep\b/;
const TAIL_FOLLOW = /\btail\b[^|;&\n]*?\s(?:-[A-Za-z]*[fF][A-Za-z0-9]*|--follow(?:=\w+)?)(?=\s|$)/;

/** The kinds of polling this tool call is (none for most calls). */
export function pollKinds(toolName: string, input: Record<string, unknown>): PollKind[] {
	if (toolName === "read") return typeof input.path === "string" && input.path.startsWith("proc://") ? ["proc"] : [];
	if (toolName !== "bash" || typeof input.command !== "string") return [];
	const command = withoutHeredocs(input.command);
	const kinds: PollKind[] = [];
	if (SLEEP_THEN_COMMAND.test(command) || WHILE_SLEEP.test(command)) kinds.push("sleep");
	const gh = GH_RUN.exec(command)?.[1];
	// `gh run watch` under `async: true` is the way the hint recommends, not a poll.
	if (gh && !(gh === "watch" && input.async === true)) kinds.push("gh-run");
	if (PGREP.test(command)) kinds.push("pgrep");
	if (TAIL_FOLLOW.test(command)) kinds.push("tail-f");
	return kinds;
}

const EDIT_MISUSE = /anchors to lines|not from this session/i;

/** What a finished tool call looked like, for the kinds that read the outcome (an `edit` the tool refused). */
export interface ToolOutcome {
	isError: boolean;
	text: string;
}

/** True for an `edit` the tool refused because its anchors or tag were not from a read the session made. */
export function editMisuse(toolName: string, outcome: ToolOutcome | undefined): boolean {
	return toolName === "edit" && outcome?.isError === true && EDIT_MISUSE.test(outcome.text);
}

/**
 * Remembers which kinds were already pointed out (a poll of each kind, an edit the tool refused); one per process, since
 * an omp process is one session. Returns the hint to append to the call's result, once per kind.
 */
export function createHints(): {
	note(toolName: string, input: Record<string, unknown>, outcome?: ToolOutcome): string | undefined;
} {
	const told = new Set<PollKind | "edit-misuse">();
	return {
		note(toolName, input, outcome) {
			if (editMisuse(toolName, outcome)) {
				if (told.has("edit-misuse")) return undefined;
				told.add("edit-misuse");
				return EDIT_HINT;
			}
			const kinds = pollKinds(toolName, input);
			const fresh = kinds.filter(kind => !told.has(kind));
			for (const kind of kinds) told.add(kind);
			return fresh.length > 0 ? POLL_HINT : undefined;
		},
	};
}
