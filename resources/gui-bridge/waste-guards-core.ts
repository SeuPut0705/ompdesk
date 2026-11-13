/**
 * Four measured wastes of agent sessions (rules; wiring: waste-guards.ts; `.omp/rules/waste-guards.md`).
 *
 * 1. A `bash` service start whose `ready.log` can never match. Stock watches the service's output for the pattern, and a
 *    command whose stdout goes to a file shows none of it: the call waited the whole `ready.timeout` (5 calls, 55 min in
 *    one session, `> file 2>&1` with `ready.log` and 600 to 900 s).
 * 2. Polling: a repeated look at a job (sleep then check, the same `gh run` or `pgrep` or `read proc://` again,
 *    `tail -f`) that a backgrounded job or a schedule delivers by itself. The first look at a target is not a poll,
 *    `gh run view --log-failed` is diagnosis, and nothing in an `async: true` bash is a poll (it runs without the model
 *    and its result is delivered once). One non-blocking hint per kind and process.
 * 3. An `edit` the tool refused for anchoring to lines the latest read never showed, or a tag the session never got
 *    (36 errors in 14 days, all agent misuse). One non-blocking hint per process.
 * 4. A `wait` that comes back with nothing: stock's `wait` returns when its window (5 s, 10 s, 30 s, 60 s, 300 s,
 *    restarting at 5 s after any wait that brought news) runs out while every job it watches still runs, and each such
 *    return is a model call that only waits again (296 in 7 days on one Mac, against 106 polls). The bridge's `wait`
 *    calls stock's again until something is new (`waitWindowElapsed`).
 *
 * No omp imports: the GUI's vitest runs it (src/main/bridge-waste-guards.test.ts).
 */

export const READY_LOG_REASON =
	"OMPdesk: ready.log can never match — the command sends its stdout to a file, so the log line is never seen and the call would wait the whole ready.timeout (measured 55 min lost in one session). Run it with async: true and `wait`, or keep stdout visible (`| tee file`).";

export const POLL_HINT =
	"OMPdesk: this polled. A backgrounded job (async: true, or a bash that outlives 60 s) delivers its result by itself; `wait` blocks until then; for CI checks ompdesk_checks op wait (or `ompdesk checks wait`), which wakes you with the result. Each look costs a model call.";

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

/**
 * One status look a call makes. A look with a `key` (the thing looked at: a run id, a list's arguments, a pattern, a
 * proc path) is a poll only when the same key was looked at before; one without is a poll at first sight (sleeping to
 * wait, `tail -f`, a foreground `gh run watch`).
 */
export interface Look {
	kind: PollKind;
	key?: string;
}

const SLEEP_THEN_COMMAND = /\bsleep\s+[\d.]+[smhd]?\s*(?:;|&&|\|\||\||&|\n)\s*\S/;
const WHILE_SLEEP = /\bwhile\b[\s\S]*\bsleep\b/;
/** `gh run` subcommands that look at runs. */
const GH_RUN_LOOK = /^(?:list|view|watch)$/;
const TAIL_FOLLOW = /\btail\b[^|;&\n]*?\s(?:-[A-Za-z]*[fF][A-Za-z0-9]*|--follow(?:=\w+)?)(?=\s|$)/;
/** `gh run view` flags that take a value, so the number after one is not the run id. */
const GH_VIEW_VALUE_FLAG = /^(?:-a|--attempt|-j|--job|--json|-q|--jq|-t|--template|-R|--repo)$/;

/** The command cut at `; & | newline` outside quotes. */
function segments(command: string): string[] {
	const out: string[] = [];
	let start = 0;
	let quote = "";
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === "\\" && quote === '"') i++;
			else if (ch === quote) quote = "";
			continue;
		}
		if (ch === "\\") i++;
		else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
			out.push(command.slice(start, i));
			start = i + 1;
		}
	}
	out.push(command.slice(start));
	return out;
}

/** Words of one segment, quotes removed; `( ) \`` end a word and redirections are dropped. */
function words(src: string): string[] {
	const out: string[] = [];
	let cur = "";
	let has = false;
	let quote = "";
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < src.length) cur += src[++i];
			else if (ch === quote) quote = "";
			else cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			has = true;
		} else if (ch === "\\" && i + 1 < src.length) {
			cur += src[++i];
			has = true;
		} else if (/[\s()`]/.test(ch)) {
			if (has) out.push(cur);
			cur = "";
			has = false;
		} else {
			cur += ch;
			has = true;
		}
	}
	if (has) out.push(cur);
	return out.filter(word => !/^\d*[<>]/.test(word));
}

/**
 * The `gh run` and `pgrep` looks of a command: what each one looks at, so a repeat can be told from a first look. Read
 * from the words, so a quoted mention (`grep -c "gh run watch"`) is not a look.
 */
function commandLooks(command: string): Look[] {
	const looks: Look[] = [];
	for (const part of segments(command)) {
		const said = words(part);
		const gh = said.findIndex(
			(word, i) => word === "gh" && said[i + 1] === "run" && GH_RUN_LOOK.test(said[i + 2] ?? ""),
		);
		if (gh >= 0) {
			const sub = said[gh + 2];
			const args = said.slice(gh + 3);
			if (sub === "watch") {
				looks.push({ kind: "gh-run" });
			} else if (sub === "list") {
				looks.push({ kind: "gh-run", key: `list ${args.join(" ")}` });
			} else if (!args.some(arg => arg === "--log" || arg === "--log-failed")) {
				// `view --log`/`--log-failed` reads what failed: a diagnosis, never a status look.
				let run: string | undefined;
				let job: string | undefined;
				for (let i = 0; i < args.length; i++) {
					const arg = args[i];
					const inline = /^(?:--job|-j)=(.+)$/.exec(arg);
					if (inline) job = inline[1];
					else if (arg === "--job" || arg === "-j") job = args[++i];
					else if (GH_VIEW_VALUE_FLAG.test(arg)) i++;
					else if (run === undefined) run = /^\d+$/.exec(arg)?.[0] ?? /\/runs\/(\d+)/.exec(arg)?.[1];
				}
				const target = run ? `${run}${job ? ` job ${job}` : ""}` : job ? `job ${job}` : args.join(" ");
				looks.push({ kind: "gh-run", key: `view ${target}` });
			}
		}
		const pgrep = said.findIndex(word => word === "pgrep" || word.endsWith("/pgrep"));
		if (pgrep >= 0) looks.push({ kind: "pgrep", key: said.slice(pgrep + 1).join(" ") });
	}
	return looks;
}

/** The status looks this tool call makes (none for most calls). */
export function pollLooks(toolName: string, input: Record<string, unknown>): Look[] {
	if (toolName === "read") {
		// The key is the process id: `proc://bg_1`, `proc://bg_1/streams/0` and `proc://bg_1:1-20` are looks at bg_1.
		const proc = typeof input.path === "string" ? /^proc:\/\/([^/:?#]+)/.exec(input.path)?.[1] : undefined;
		return proc ? [{ kind: "proc", key: proc }] : [];
	}
	// A backgrounded bash runs without the model and delivers its result once, whatever it sleeps or checks inside.
	if (toolName !== "bash" || typeof input.command !== "string" || input.async === true) return [];
	const command = withoutHeredocs(input.command);
	const looks: Look[] = [];
	if (SLEEP_THEN_COMMAND.test(command) || WHILE_SLEEP.test(command)) looks.push({ kind: "sleep" });
	looks.push(...commandLooks(command));
	if (TAIL_FOLLOW.test(command)) looks.push({ kind: "tail-f" });
	return looks;
}

/**
 * A poll is a repeated look at the same thing, not a look: the first `gh run view <id>`, `gh run list <args>`, `pgrep
 * <pattern>` or `read proc://<path>` of a session is how a person finds out; the second is waiting by hand. One tracker
 * per session (the bridge keeps one per omp process, the pace reader one per journal).
 */
export function createPollTracker(): { observe(toolName: string, input: Record<string, unknown>): PollKind[] } {
	const seen = new Set<string>();
	return {
		observe(toolName, input) {
			const kinds = new Set<PollKind>();
			for (const { kind, key } of pollLooks(toolName, input)) {
				if (key === undefined) {
					kinds.add(kind);
					continue;
				}
				const id = `${kind}\0${key}`;
				if (seen.has(id)) kinds.add(kind);
				else seen.add(id);
			}
			return [...kinds];
		},
	};
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

/** The bridge's `wait` (stock's `wait`, called again while its window runs out with nothing new). */
export const WAIT_DESCRIPTION = `Wait only when blocked with nothing else to do.
Blocks until a background job or service you started finishes, a message arrives, or the answer to a question you sent this run comes in. It does not return while your jobs only keep running.
Nothing you started running and no answer owed? Returns at once.
- MUST wait only on your own jobs/services, or rarely the answer to a question that blocks you.
- NEVER wait for another agent's progress or for messages nobody owes you.
- Result in, other jobs still running? SHOULD act on it before waiting again.
Results and messages auto-deliver. NEVER poll while work remains.`;

/** The parts of a tool result that tell a `wait` which came back with nothing from one that brought news. */
export interface WaitResult {
	details?: unknown;
	useless?: boolean;
}

/**
 * True for a stock `wait` result that came back only because its window ran out while every job it watched still
 * runs: stock flags it `useless` and lists the jobs, none settled. A wait on nothing, on a service alone, or for a reply
 * lists no job, and a finished job, a message or an interrupt is never `useless`; none of those count.
 */
export function waitWindowElapsed(result: WaitResult): boolean {
	const { details } = result;
	if (result.useless !== true || typeof details !== "object" || details === null) return false;
	if (!("op" in details) || details.op !== "wait" || !("jobs" in details) || !Array.isArray(details.jobs))
		return false;
	const jobs: unknown[] = details.jobs;
	return (
		jobs.length > 0 &&
		jobs.every(job => typeof job === "object" && job !== null && "status" in job && job.status === "running")
	);
}

/**
 * Remembers which kinds were already pointed out (a poll of each kind, an edit the tool refused); one per process, since
 * an omp process is one session. Returns the hint to append to the call's result, once per kind.
 */
export function createHints(): {
	note(toolName: string, input: Record<string, unknown>, outcome?: ToolOutcome): string | undefined;
} {
	const told = new Set<PollKind | "edit-misuse">();
	const polls = createPollTracker();
	return {
		note(toolName, input, outcome) {
			if (editMisuse(toolName, outcome)) {
				if (told.has("edit-misuse")) return undefined;
				told.add("edit-misuse");
				return EDIT_HINT;
			}
			const kinds = polls.observe(toolName, input);
			const fresh = kinds.filter(kind => !told.has(kind));
			for (const kind of kinds) told.add(kind);
			return fresh.length > 0 ? POLL_HINT : undefined;
		},
	};
}
