/**
 * Builds the work card's verdict replay corpus (`e2e/fixtures/work-verdict-corpus.json`) from this computer's real omp
 * journals of this repository's own sessions (its main checkout and its OMPdesk worktrees): slices of consecutive turns around every turn that ran a command or had a call
 * fail, reduced to what the card's verdict reads and redacted for a public repository.
 *
 *   bun scripts/work-verdict-corpus.ts [--max-bytes 2500000]   (run from one of the repository's worktrees)
 *
 * Kept: the shape of every message (a reply's text and thinking become "x", blank stays blank: rows split on them),
 * every tool call's arguments (a command redacted; an edit's paths; any other string over 80 characters as a hash, so
 * equal arguments stay equal), a tool result's error flag, its exit details, its text (redacted, the first 300 and the
 * last 3,700 characters), diffs as their `+`/`-` line marks only, background job deliveries. Dropped: images, every
 * other result detail. `work-verdict-replay.test.ts` replays the corpus through the real card and board, and fails
 * when any card's verdict moves; `work-verdict-corpus.test.ts` refuses a corpus that holds a secret or an address.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { redactDiagnosticsText } from "../resources/gui-bridge/redactor";
import { editArgumentPaths } from "../src/renderer/components/tools/edit-args";
import { TURN_EDIT_TOOLS } from "../src/shared/turn-edits";

export const CORPUS_PATH = "e2e/fixtures/work-verdict-corpus.json";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Message = { [key: string]: Json };

export interface CorpusSlice {
	/** `<session file name>#<first turn>`: where it came from, for a person reading a failing case. */
	id: string;
	cwd: string;
	messages: Message[];
}

const arg = (name: string): string | undefined => {
	const at = process.argv.indexOf(name);
	return at >= 0 ? process.argv[at + 1] : undefined;
};

const redact = (text: string): string => redactDiagnosticsText(text);
const hash = (text: string): string => `h:${createHash("sha256").update(text).digest("hex").slice(0, 10)}`;

/** A command's output as the rules read it: its start (stock's leading notices) and its end (counts, exit trailer). */
function clip(text: string): string {
	const redacted = redact(text);
	return redacted.length <= 1_600 ? redacted : `${redacted.slice(0, 200)}\n…\n${redacted.slice(-1_400)}`;
}

/** Arguments with every long string hashed (equal stays equal) and the rest redacted. */
function reduceValue(value: Json): Json {
	if (typeof value === "string") return value.length > 80 ? hash(value) : redact(value);
	if (Array.isArray(value)) return value.map(reduceValue);
	if (value && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, reduceValue(inner)]));
	return value;
}

/** A command with each here-document body as one hashed line: the rules read a body as text, equal stays equal. */
function squashHeredocs(command: string): string {
	const lines = command.split("\n");
	const kept: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		kept.push(line);
		const tag = /<<-?[ \t]*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_]\w*))/.exec(line);
		const word = tag?.[1] ?? tag?.[2] ?? tag?.[3];
		if (!word) continue;
		const body: string[] = [];
		while (index + 1 < lines.length && (lines[index + 1] ?? "").trim() !== word) body.push(lines[++index] ?? "");
		if (body.length) kept.push(hash(body.join("\n")));
	}
	return kept.join("\n");
}

function reduceArgs(tool: string, args: { [key: string]: Json }): { [key: string]: Json } {
	if (tool === "bash") {
		const kept: { [key: string]: Json } = {};
		if (typeof args.command === "string") kept.command = redact(squashHeredocs(args.command));
		if (typeof args.cwd === "string") kept.cwd = redact(args.cwd);
		if (args.async !== undefined) kept.async = args.async;
		return kept;
	}
	if (TURN_EDIT_TOOLS.includes(tool)) {
		const [path, ...rest] = editArgumentPaths(args).map(redact);
		return { ...(path ? { path } : {}), ...(rest.length ? { edits: rest.map(item => ({ path: item })) } : {}) };
	}
	if (tool === "read" && typeof args.path === "string")
		return { ...(reduceValue(args) as object), path: redact(args.path) };
	return reduceValue(args) as { [key: string]: Json };
}

const diffMarks = (diff: Json): Json =>
	typeof diff === "string"
		? diff
				.split("\n")
				.map(line => (line.startsWith("+") || line.startsWith("-") ? line[0] : " "))
				.join("\n")
		: null;

function reduceJobs(jobs: Json): Json {
	if (!Array.isArray(jobs)) return null;
	return jobs.map(job => {
		if (!job || typeof job !== "object" || Array.isArray(job)) return null;
		const kept: { [key: string]: Json } = {};
		for (const key of ["id", "jobId", "status", "exitCode", "type", "label"])
			if (job[key] !== undefined) kept[key] = typeof job[key] === "string" ? redact(job[key]) : job[key];
		for (const key of ["resultText", "errorText", "text"])
			if (typeof job[key] === "string") kept[key] = clip(job[key]);
		return kept;
	});
}

/** The result details the card's rules read (work-view.ts `workOutcomes`, completion-events.ts). */
function reduceDetails(details: Json): Json {
	if (!details || typeof details !== "object" || Array.isArray(details)) return null;
	const kept: { [key: string]: Json } = {};
	for (const key of ["exitCode", "timedOut", "wallTimeMs", "source", "op"])
		if (details[key] !== undefined) kept[key] = details[key];
	if (typeof details.path === "string") kept.path = redact(details.path);
	if (details.diff !== undefined) kept.diff = diffMarks(details.diff);
	const async = details.async;
	if (async && typeof async === "object" && !Array.isArray(async))
		kept.async = {
			...(async.state !== undefined ? { state: async.state } : {}),
			...(async.jobId !== undefined ? { jobId: async.jobId } : {}),
		};
	if (Array.isArray(details.perFileResults))
		kept.perFileResults = details.perFileResults.map(file =>
			file && typeof file === "object" && !Array.isArray(file)
				? {
						...(typeof file.path === "string" ? { path: redact(file.path) } : {}),
						...(typeof file.move === "string" ? { move: redact(file.move) } : {}),
						...(file.op !== undefined ? { op: file.op } : {}),
						...(file.isError !== undefined ? { isError: file.isError } : {}),
						...(file.diff !== undefined ? { diff: diffMarks(file.diff) } : {}),
					}
				: null,
		);
	if (details.jobs !== undefined) kept.jobs = reduceJobs(details.jobs);
	if (typeof details.name === "string") kept.name = details.name;
	return kept;
}

const reduceContent = (content: Json, keepText: (text: string) => string): Json =>
	typeof content === "string"
		? keepText(content)
		: Array.isArray(content)
			? content.flatMap(block => {
					if (!block || typeof block !== "object" || Array.isArray(block)) return [];
					if (block.type === "image") return [];
					if (block.type === "text") return [{ type: "text", text: keepText(String(block.text ?? "")) }];
					if (block.type === "thinking")
						return [{ type: "thinking", thinking: String(block.thinking ?? "").trim() ? "x" : "" }];
					if (block.type === "toolCall")
						return [
							{
								type: "toolCall",
								id: block.id,
								name: block.name,
								arguments: reduceArgs(String(block.name), (block.arguments ?? {}) as { [key: string]: Json }),
								...(typeof block.intent === "string" ? { intent: redact(block.intent) } : {}),
							},
						];
					return [];
				})
			: content;

const blankOr = (text: string): string => (text.trim() ? "x" : text);

function reduceMessage(message: Message): Message | null {
	const keep = (...keys: string[]) =>
		Object.fromEntries(keys.flatMap(key => (message[key] !== undefined ? [[key, message[key]]] : [])));
	switch (message.role) {
		case "user":
			return { ...keep("role", "timestamp", "attribution"), content: reduceContent(message.content, blankOr) };
		case "assistant":
			return {
				...keep("role", "timestamp", "stopReason", "errorId"),
				...(typeof message.errorMessage === "string"
					? { errorMessage: message.errorMessage.startsWith("__omp.") ? message.errorMessage : "x" }
					: {}),
				content: reduceContent(message.content, blankOr),
			};
		case "toolResult": {
			const bash = message.toolName === "bash";
			return {
				...keep("role", "toolCallId", "toolName", "isError", "timestamp"),
				// Another tool's text says something only when it failed (the guard's refusal, the cause line).
				content: reduceContent(message.content, text =>
					bash ? clip(text) : message.isError === true ? clip(text).slice(0, 300) : blankOr(text),
				),
				details: reduceDetails(message.details),
			};
		}
		case "custom": {
			const asyncResult = message.customType === "async-result";
			return {
				...keep("role", "customType", "display", "timestamp", "attribution"),
				content: reduceContent(message.content, text => (asyncResult ? clip(text) : blankOr(text))),
				details: asyncResult || message.customType === "skill-prompt" ? reduceDetails(message.details) : null,
			};
		}
		default:
			return null;
	}
}

/** A journal as the transcript the GUI loads: message entries, custom messages as `custom` messages. */
function transcript(lines: { [key: string]: Json }[]): Message[] {
	const messages: Message[] = [];
	for (const entry of lines) {
		if (
			entry.type === "message" &&
			entry.message &&
			typeof entry.message === "object" &&
			!Array.isArray(entry.message)
		)
			messages.push(entry.message as Message);
		else if (entry.type === "custom_message")
			messages.push({
				role: "custom",
				customType: entry.customType ?? null,
				content: entry.content ?? "",
				display: entry.display ?? true,
				details: entry.details ?? null,
				timestamp: typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : (entry.timestamp ?? 0),
			});
	}
	return messages;
}

function interesting(turn: readonly Message[]): boolean {
	return turn.some(
		message => message.role === "toolResult" && (message.isError === true || message.toolName === "bash"),
	);
}

function slices(file: string): CorpusSlice[] {
	const lines = readFileSync(file, "utf8")
		.split("\n")
		.flatMap(line => {
			try {
				return line ? [JSON.parse(line) as { [key: string]: Json }] : [];
			} catch {
				return [];
			}
		});
	const header = lines.find(line => line.type === "session");
	const cwd = typeof header?.cwd === "string" ? redact(header.cwd) : "";
	const turns: Message[][] = [];
	for (const message of transcript(lines)) {
		if (message.role === "user" || turns.length === 0) turns.push([]);
		turns.at(-1)?.push(message);
	}
	// Each interesting turn with the one after it (its background jobs' deliveries); touching windows join.
	const keep = new Set<number>();
	turns.forEach((turn, index) => {
		if (!interesting(turn)) return;
		keep.add(index);
		if (index + 1 < turns.length) keep.add(index + 1);
	});
	const out: CorpusSlice[] = [];
	// `<day>-<the session id's last group>`: names the journal without a long run the redactor would take for a token.
	const name = basename(file, ".jsonl").replace(/^(\d{4}-\d\d-\d\d)T.*-([0-9a-f]{12})$/, "$1-$2");
	let current: Message[] | undefined;
	const open = () => {
		current = [];
		out.push({ id: `${name}#${out.length}`, cwd, messages: current });
		return current;
	};
	for (let index = 0; index < turns.length; index++) {
		if (!keep.has(index)) {
			current = undefined;
			continue;
		}
		for (const message of turns[index] ?? []) {
			const reduced = reduceMessage(message);
			if (!reduced) continue;
			// A long autonomous turn is cut into pages before a reply, as history pages load: a call keeps its result.
			const page = current && current.length >= SLICE_MESSAGES && reduced.role === "assistant" ? undefined : current;
			(page ?? open()).push(reduced);
		}
	}
	return out;
}

/** Messages per slice: a long turn becomes several slices, so one session cannot fill the corpus. */
const SLICE_MESSAGES = 24;

/**
 * Whether a journal's folder is this repository's: its main checkout or one of its OMPdesk worktrees (`~/.omp/wt/<name>-<repo
 * id>`, the id this checkout's own folder ends with when it is one). Other projects' sessions never enter the corpus.
 */
function ourFolder(): (cwd: string) => boolean {
	const main = dirname(
		execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim(),
	);
	const repoId = /-[0-9a-f]{7}$/.exec(basename(process.cwd()))?.[0];
	return cwd =>
		cwd === main ||
		cwd.startsWith(`${main}/`) ||
		(repoId !== undefined && /\/\.omp\/wt\/[^/]+$/.test(cwd) && cwd.endsWith(repoId));
}

function journalCwd(file: string): string {
	const head = readFileSync(file, "utf8").slice(0, 8_192).split("\n");
	for (const line of head) {
		try {
			const entry = JSON.parse(line) as { type?: string; cwd?: string };
			if (entry.type === "session") return entry.cwd ?? "";
		} catch {}
	}
	return "";
}

if (import.meta.main) {
	const root = join(homedir(), ".omp", "agent", "sessions");
	const ours = ourFolder();
	const maxBytes = Number(arg("--max-bytes") ?? 2_500_000);
	const files = readdirSync(root)
		.flatMap(dir =>
			readdirSync(join(root, dir))
				.filter(name => name.endsWith(".jsonl"))
				.map(name => join(root, dir, name)),
		)
		.filter(file => ours(journalCwd(file)))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	// One slice from each journal in turn (newest journal first), so the corpus spans every session's habits.
	const queues = files.map(slices);
	const corpus: CorpusSlice[] = [];
	let bytes = 2;
	for (let round = 0; queues.some(queue => queue.length > round); round++) {
		for (const queue of queues) {
			const slice = queue[round];
			if (!slice) continue;
			const size = JSON.stringify(slice).length + 2;
			if (bytes + size > maxBytes) continue;
			corpus.push(slice);
			bytes += size;
		}
	}
	corpus.sort((a, b) => a.id.localeCompare(b.id));
	writeFileSync(CORPUS_PATH, `[\n${corpus.map(slice => JSON.stringify(slice)).join(",\n")}\n]\n`);
	console.log(
		`[work-verdict-corpus] ${corpus.length} slices from ${files.length} journals, ${(bytes / 1e6).toFixed(2)} MB → ${CORPUS_PATH}`,
	);
}
