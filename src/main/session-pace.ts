/**
 * Where a session's wall time went: model generation against tool execution, by tool, with call and error counts,
 * and the waste a brief can cut (one file read over and over, model calls far outnumbering tool calls).
 *
 * Reads stock omp's session journal: a `tool_execution_start` custom entry marks when a tool began and the
 * `toolResult` message when it ended; tool time is the union of those intervals (parallel calls overlap). A gap
 * longer than `IDLE_S` between messages is idle only where no tool ran through it (a `wait` that returned after
 * 20 min is that tool's time). An assistant message's timestamp is the end of its generation, so the residual
 * (wall − tools − idle) is the model's generation plus whatever the harness spent between calls; the two are not
 * separated here. Per-tool rows sum each tool's own durations and may add up to more than the union.
 *
 * Measured (4 Nov 2026, `scripts/session-pace.ts` over that day's sessions): tool execution was 2 to 3 minutes of
 * sessions whose wall was 22 to 120 minutes; the rest was 90 to 230 model calls at a median of 4 to 6 s each. The
 * `Pace:` line main adds to a child's done report (`agent-control/service.ts` `#report`) and the short form in
 * `ompdesk_sessions` and `ompdesk_session_result` put that number in front of the session that wrote the brief.
 */

import * as fs from "node:fs/promises";
import { checkKinds } from "../../resources/gui-bridge/command-verdict-core";
import { createPollTracker, waitWindowElapsed } from "../../resources/gui-bridge/waste-guards-core";

const IDLE_S = 600;
/** Model calls per tool call from which a session is reading and thinking instead of working. */
export const WASTE_CALL_RATIO = 1.5;
/** Polling shell commands or `proc://` reads from which a session should have backgrounded the job and `wait`ed. */
export const WASTE_POLLS = 5;
/**
 * Tool calls below which the ratio says nothing: every session ends with one answer past its last tool call, so one
 * tool call always reads 2.0 and two read 1.5 (measured on a two-call child, 4 Nov 2026).
 */
export const WASTE_MIN_TOOL_CALLS = 10;
/** Reads of one file from which the session should have kept what it read. */
export const WASTE_READS = 10;

/** A command that waits for a CI run's verdict: `gh run watch`, this repository's `scripts/watch-run.ts`. */
const CI_WATCH = /\bgh\s+run\s+watch\b|\bwatch-run\.ts\b/;

/**
 * Whether a shell command runs a check: a test, type check, lint or build as the work card names them (`checkKinds`,
 * the one owner of that rule), or a wait for a CI run's verdict.
 */
export function checkRun(command: string): boolean {
	return checkKinds(command, true).length > 0 || CI_WATCH.test(command);
}

interface Entry {
	type?: string;
	customType?: string;
	timestamp?: string | number;
	data?: { toolCallId?: string };
	message?: {
		role?: string;
		timestamp?: number;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		usage?: { output?: number };
		content?: unknown;
		details?: { async?: { jobId?: string }; jobs?: JobSnapshot[] };
		useless?: boolean;
	};
}

/** A background job as a `wait` result lists it. */
interface JobSnapshot {
	id?: string;
	type?: string;
	/** How long it has run, or ran. */
	durationMs?: number;
	/** Absent while it runs. */
	settledAtMs?: number;
}

interface ToolCallPart {
	type?: string;
	id?: string;
	name?: string;
	arguments?: { path?: unknown; command?: unknown; async?: unknown };
}

export interface ToolRow {
	seconds: number;
	calls: number;
	errors: number;
}

/** JSON-safe (a paired host sends it over the link as `sessions.pace`). */
export interface Pace {
	wallS: number;
	/** Union of tool intervals. */
	toolS: number;
	/** wall − tools − idle: model generation plus harness time between calls. */
	modelS: number;
	idleS: number;
	modelCalls: number;
	outputTokens: number;
	tools: Record<string, ToolRow>;
	/** Seconds from the message before each assistant message to it: one model call's generation. */
	thinkGaps: number[];
	/** The file `read` most often and how often; absent until a file was read twice. */
	repeatRead?: { path: string; count: number };
	/**
	 * Polls: shell commands that poll (`sleep N`, `gh run view/list/watch`, `pgrep`, `tail -f`), reads of `proc://`, and
	 * `wait` calls that came back with nothing (stock's window ran out while the jobs ran on).
	 */
	polls: number;
	/** `polls` by kind (`sleep`, `gh-run`, `pgrep`, `tail-f`, `proc`, and `wait` for one that came back with nothing). */
	pollKinds?: Record<string, number>;
	/**
	 * Checks (`checkRun`): how many were started, and the time inside tool calls while one ran: a check's own call, and
	 * a `wait` for as long as a backgrounded check it lists was running. Part of `toolS`. Absent without a check, and
	 * in a paired host's answer from before this field.
	 */
	checks?: { runs: number; seconds: number; savedS?: number };
}

/**
 * The last line of an `ompdesk check` run (`native/ompdesk/crates/checks/src/check.rs` `finish`): its id and the
 * seconds its reused results saved. A run's line reaches the journal in its bash call's result, a `wait`'s or a log
 * read; each run counts once.
 */
const CHECK_SAVED = /ompdesk check: (\d{8}-\d{6}-[0-9a-f]{4}): \w+ in [^\n]*? reuse saved about [^\n(]*\((\d+) s\)/g;

function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { text?: unknown } | null) => (typeof part?.text === "string" ? part.text : ""))
		.join("\n");
}

function seconds(entry: Entry): number | undefined {
	const stamp = entry.timestamp ?? entry.message?.timestamp;
	if (typeof stamp === "number") return stamp / 1000;
	if (typeof stamp === "string") return Date.parse(stamp) / 1000;
	return undefined;
}

/** Total length of the union of `[start, end]` intervals (parallel tool calls overlap). */
export function unionSeconds(intervals: readonly (readonly [number, number])[]): number {
	const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
	let total = 0;
	let open: [number, number] | undefined;
	for (const [start, end] of sorted) {
		if (open && start <= open[1]) open[1] = Math.max(open[1], end);
		else {
			if (open) total += open[1] - open[0];
			open = [start, end];
		}
	}
	if (open) total += open[1] - open[0];
	return total;
}

/** `src/x.ts:50-80` and `notes.txt:-5` are reads of one file; a drive letter's colon has a separator after it. */
function readTarget(part: ToolCallPart): string | undefined {
	if (part.type !== "toolCall" || part.name !== "read" || typeof part.arguments?.path !== "string") return undefined;
	return part.arguments.path.replace(/(?<=.):[^\\/]*$/, "");
}

export function pace(lines: Iterable<string>): Pace {
	const starts = new Map<string, number>();
	const tools: Record<string, ToolRow> = {};
	const intervals: [number, number][] = [];
	const thinkGaps: number[] = [];
	const reads = new Map<string, number>();
	let first: number | undefined;
	let modelCalls = 0;
	let outputTokens = 0;
	let polls = 0;
	const pollKinds: Record<string, number> = {};
	const polled = (kind: string): void => {
		polls++;
		pollKinds[kind] = (pollKinds[kind] ?? 0) + 1;
	};
	const pollTracker = createPollTracker();
	/** Calls that run a check, the background jobs that are one (a job id comes back after an omp restart). */
	const checkCalls = new Set<string>();
	const checkJobs = new Set<string>();
	const checkIntervals: [number, number][] = [];
	const checkSaved = new Map<string, number>();
	let prev: number | undefined;
	const gaps: [number, number][] = [];
	for (const line of lines) {
		let entry: Entry;
		try {
			entry = JSON.parse(line) as Entry;
		} catch {
			continue;
		}
		const at = seconds(entry);
		if (at === undefined) continue;
		if (entry.type === "custom" && entry.customType === "tool_execution_start") {
			if (entry.data?.toolCallId) starts.set(entry.data.toolCallId, at);
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		first ??= at;
		if (prev !== undefined && at - prev > IDLE_S) gaps.push([prev, at]);
		const since = prev !== undefined ? at - prev : undefined;
		prev = at;
		const { role } = entry.message;
		if (role === "assistant") {
			modelCalls++;
			outputTokens += entry.message.usage?.output ?? 0;
			if (since !== undefined && since <= IDLE_S) thinkGaps.push(since);
			if (Array.isArray(entry.message.content))
				for (const part of entry.message.content as ToolCallPart[]) {
					const target = readTarget(part);
					if (target !== undefined) reads.set(target, (reads.get(target) ?? 0) + 1);
					if (part.type !== "toolCall" || !part.name || !part.arguments) continue;
					const kind = pollTracker.observe(part.name, part.arguments)[0];
					if (kind) polled(kind);
					if (
						part.name === "bash" &&
						part.id &&
						typeof part.arguments.command === "string" &&
						checkRun(part.arguments.command)
					)
						checkCalls.add(part.id);
				}
		} else if (role === "toolResult") {
			const name = entry.message.toolName ?? "?";
			const row = tools[name] ?? { seconds: 0, calls: 0, errors: 0 };
			const id = entry.message.toolCallId;
			const began = id ? starts.get(id) : undefined;
			if (began !== undefined) {
				row.seconds += at - began;
				intervals.push([began, at]);
			}
			row.calls++;
			if (entry.message.isError) row.errors++;
			for (const [, run, saved] of resultText(entry.message.content).matchAll(CHECK_SAVED))
				if (run) checkSaved.set(run, Number(saved));
			const details = entry.message.details;
			if (name === "bash" && id) {
				const check = checkCalls.has(id);
				if (check && began !== undefined) checkIntervals.push([began, at]);
				const job = details?.async?.jobId;
				if (job && check) checkJobs.add(job);
				else if (job) checkJobs.delete(job);
			}
			if (name === "wait") {
				if (waitWindowElapsed(entry.message)) polled("wait");
				for (const job of began !== undefined && Array.isArray(details?.jobs) ? details.jobs : []) {
					if (job.type !== "bash" || !job.id || !checkJobs.has(job.id)) continue;
					const end = Math.min(at, typeof job.settledAtMs === "number" ? job.settledAtMs / 1000 : at);
					const from = Math.max(began ?? at, end - (job.durationMs ?? 0) / 1000);
					if (end > from) checkIntervals.push([from, end]);
				}
			}
			tools[name] = row;
		}
	}
	const wallS = first !== undefined && prev !== undefined ? prev - first : 0;
	let savedS = 0;
	for (const saved of checkSaved.values()) savedS += saved;
	const toolS = unionSeconds(intervals);
	// A long gap is idle only where no tool ran through it (a `wait` that returned after 20 min is that tool's time).
	const idleS = gaps.reduce((sum, [from, to]) => sum + (to - from) - unionSeconds(clip(intervals, from, to)), 0);
	let repeatRead: Pace["repeatRead"];
	for (const [path, count] of reads) if (count > 1 && count > (repeatRead?.count ?? 0)) repeatRead = { path, count };
	return {
		wallS,
		toolS,
		modelS: Math.max(0, wallS - toolS - idleS),
		idleS,
		modelCalls,
		outputTokens,
		tools,
		thinkGaps,
		polls,
		...(repeatRead ? { repeatRead } : {}),
		...(polls > 0 ? { pollKinds } : {}),
		...(checkCalls.size > 0
			? {
					checks: {
						runs: checkCalls.size,
						seconds: unionSeconds(checkIntervals),
						...(savedS > 0 ? { savedS } : {}),
					},
				}
			: {}),
	};
}

function clip(intervals: readonly [number, number][], from: number, to: number): [number, number][] {
	return intervals
		.filter(([start, end]) => end > from && start < to)
		.map(([start, end]) => [Math.max(start, from), Math.min(end, to)]);
}

export function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

export function toolCalls(result: Pace): number {
	return Object.values(result.tools).reduce((sum, row) => sum + row.calls, 0);
}

export function toolErrors(result: Pace): number {
	return Object.values(result.tools).reduce((sum, row) => sum + row.errors, 0);
}

/**
 * What the brief that opened this session can cut next time, or undefined: a file read `WASTE_READS` times or
 * more, or, past `WASTE_MIN_TOOL_CALLS`, `WASTE_CALL_RATIO` model calls per tool call or more (the session thought
 * and re-read instead of acting).
 */
export function waste(result: Pace): string | undefined {
	const parts: string[] = [];
	if (result.repeatRead && result.repeatRead.count >= WASTE_READS)
		parts.push(`read ${result.repeatRead.path} ×${result.repeatRead.count}`);
	const calls = toolCalls(result);
	if (calls >= WASTE_MIN_TOOL_CALLS && result.modelCalls / calls >= WASTE_CALL_RATIO)
		parts.push(`${(result.modelCalls / calls).toFixed(1)} model calls per tool call`);
	if (result.polls >= WASTE_POLLS) {
		const kinds = Object.entries(result.pollKinds ?? {})
			.sort((a, b) => b[1] - a[1])
			.map(([kind, count]) => `${kind} ×${count}`);
		parts.push(`polled ×${result.polls}${kinds.length > 0 ? ` (${kinds.join(", ")})` : ""}`);
	}
	return parts.length > 0 ? parts.join(", ") : undefined;
}

const span = (s: number): string => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

/**
 * `checks ×46 31 min (82% of tools)`: the checks started, the tool time one ran through, and its share of tool time;
 * `, 12 min saved by reuse` when `ompdesk check` runs reused earlier results.
 */
function checksPart(result: Pace): string | undefined {
	if (!result.checks) return undefined;
	const share = result.toolS > 0 ? Math.round((result.checks.seconds / result.toolS) * 100) : 0;
	const saved = result.checks.savedS ? `, ${span(result.checks.savedS)} saved by reuse` : "";
	return `checks ×${result.checks.runs} ${span(result.checks.seconds)} (${share}% of tools${saved})`;
}

/** The one line a done report ends with: `Pace: wall 22 min · model+between-calls 20 min (156 calls, median 4.0 s) · tools 2 min · checks ×3 61 s (51% of tools) · errors 6`. */
export function paceLine(result: Pace): string {
	const parts = [
		`wall ${span(result.wallS)}`,
		`model+between-calls ${span(result.modelS)} (${result.modelCalls} calls, median ${percentile(result.thinkGaps, 0.5).toFixed(1)} s)`,
		`tools ${span(result.toolS)}`,
	];
	const checks = checksPart(result);
	if (checks) parts.push(checks);
	if (result.idleS > 0) parts.push(`idle ${span(result.idleS)}`);
	parts.push(`errors ${toolErrors(result)}`);
	const cut = waste(result);
	if (cut) parts.push(`waste: ${cut}`);
	return `Pace: ${parts.join(" · ")}`;
}

const cache = new Map<string, { size: number; mtimeMs: number; pace: Pace }>();

/**
 * The pace of a session file, read once per change (a list of 50 sessions asks for each on every call). Undefined
 * when the file cannot be read: a pace never keeps a report or a list from going out.
 */
export async function readPace(sessionPath: string): Promise<Pace | undefined> {
	try {
		const info = await fs.stat(sessionPath);
		const hit = cache.get(sessionPath);
		if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.pace;
		const result = pace((await fs.readFile(sessionPath, "utf8")).split("\n"));
		cache.set(sessionPath, { size: info.size, mtimeMs: info.mtimeMs, pace: result });
		return result;
	} catch {
		return undefined;
	}
}
