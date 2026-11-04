/**
 * Where a session's wall time went: model generation against tool execution, by tool, with call and error counts.
 *
 *   bun scripts/session-pace.ts <session.jsonl> [more.jsonl…]
 *   bun scripts/session-pace.ts --latest [N]        the N (default 3) most recently changed sessions under ~/.omp
 *
 * Reads stock omp's session journal: a `tool_execution_start` custom entry marks when a tool began and the
 * `toolResult` message when it ended; tool time is the union of those intervals (parallel calls overlap). A gap
 * longer than `IDLE_S` between messages is idle only where no tool ran through it (a `wait` that returned after
 * 20 min is that tool's time). An assistant message's timestamp is the end of its generation, so the residual
 * (wall − tools − idle) is the model's generation plus whatever the harness spent between calls; the two are not
 * separated here. Per-tool rows sum each tool's own durations and may add up to more than the union.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const IDLE_S = 600;

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
	};
}

export interface Pace {
	wallS: number;
	/** Union of tool intervals. */
	toolS: number;
	/** wall − tools − idle: model generation plus harness time between calls. */
	modelS: number;
	idleS: number;
	modelCalls: number;
	outputTokens: number;
	tools: Map<string, { seconds: number; calls: number; errors: number }>;
	thinkGaps: number[];
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

export function pace(lines: Iterable<string>): Pace {
	const starts = new Map<string, number>();
	const tools = new Map<string, { seconds: number; calls: number; errors: number }>();
	const intervals: [number, number][] = [];
	const thinkGaps: number[] = [];
	let first: number | undefined;
	let last: number | undefined;
	let modelCalls = 0;
	let outputTokens = 0;
	let lastResult: number | undefined;
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
		if (last !== undefined && at - last > IDLE_S) gaps.push([last, at]);
		last = at;
		const { role } = entry.message;
		if (role === "assistant") {
			modelCalls++;
			outputTokens += entry.message.usage?.output ?? 0;
			if (lastResult !== undefined && at - lastResult <= IDLE_S) thinkGaps.push(at - lastResult);
		} else if (role === "toolResult") {
			lastResult = at;
			const name = entry.message.toolName ?? "?";
			const row = tools.get(name) ?? { seconds: 0, calls: 0, errors: 0 };
			const began = entry.message.toolCallId ? starts.get(entry.message.toolCallId) : undefined;
			if (began !== undefined) {
				row.seconds += at - began;
				intervals.push([began, at]);
			}
			row.calls++;
			if (entry.message.isError) row.errors++;
			tools.set(name, row);
		}
	}
	const wallS = first !== undefined && last !== undefined ? last - first : 0;
	const toolS = unionSeconds(intervals);
	// A long gap is idle only where no tool ran through it (a `wait` that returned after 20 min is that tool's time).
	const idleS = gaps.reduce((sum, [from, to]) => sum + (to - from) - unionSeconds(clip(intervals, from, to)), 0);
	return {
		wallS,
		toolS,
		modelS: Math.max(0, wallS - toolS - idleS),
		idleS,
		modelCalls,
		outputTokens,
		tools,
		thinkGaps,
	};
}

function clip(intervals: readonly [number, number][], from: number, to: number): [number, number][] {
	return intervals
		.filter(([start, end]) => end > from && start < to)
		.map(([start, end]) => [Math.max(start, from), Math.min(end, to)]);
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

const minutes = (s: number): string => `${(s / 60).toFixed(1)} min`;

export function report(label: string, result: Pace): string {
	const out = [
		`== ${label}`,
		`wall ${minutes(result.wallS)} = model+between-calls ${minutes(result.modelS)} (${result.modelCalls} calls, median ${percentile(result.thinkGaps, 0.5).toFixed(1)} s, p90 ${percentile(result.thinkGaps, 0.9).toFixed(1)} s, ${Math.round(result.outputTokens / 1000)}k output tokens) + tools ${minutes(result.toolS)} + idle ${minutes(result.idleS)}`,
	];
	const rows = [...result.tools.entries()].sort((a, b) => b[1].seconds - a[1].seconds);
	for (const [name, row] of rows)
		out.push(
			`   ${name.padEnd(10)} ${minutes(row.seconds).padStart(9)}  calls ${String(row.calls).padStart(4)}  errors ${row.errors}`,
		);
	return out.join("\n");
}

function latest(n: number): string[] {
	const root = path.join(os.homedir(), ".omp", "agent", "sessions");
	const files: { file: string; mtime: number }[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".jsonl")) files.push({ file: full, mtime: fs.statSync(full).mtimeMs });
		}
	};
	walk(root);
	return files
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, n)
		.map(entry => entry.file);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const files = args[0] === "--latest" ? latest(Number(args[1] ?? 3)) : args;
	if (files.length === 0) {
		console.error("usage: bun scripts/session-pace.ts <session.jsonl>… | --latest [N]");
		process.exit(2);
	}
	for (const file of files) {
		const lines = fs.readFileSync(file, "utf8").split("\n");
		console.log(report(path.relative(path.join(os.homedir(), ".omp", "agent", "sessions"), file), pace(lines)));
	}
}
