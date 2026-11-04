/**
 * Where a session's wall time went: model generation against tool execution, by tool, with call and error counts.
 *
 *   bun scripts/session-pace.ts <session.jsonl> [more.jsonl…]
 *   bun scripts/session-pace.ts --latest [N]        the N (default 3) most recently changed sessions under ~/.omp
 *
 * Reads stock omp's session journal: a `tool_execution_start` custom entry marks when a tool began and the
 * `toolResult` message when it ended (their difference is the tool's own time); an assistant message's timestamp is
 * the end of its generation, so what is neither a tool running nor a gap longer than `IDLE_S` (the person away, a
 * `wait` that returned) is the model: thinking, first-token wait and output. Measured 4 Nov 2026 on two sessions:
 * harness overhead between a tool call's emission and its start was 0.00 s median; the model was 90 % of the wall.
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

interface Pace {
	wallS: number;
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

export function pace(lines: Iterable<string>): Pace {
	const starts = new Map<string, number>();
	const tools = new Map<string, { seconds: number; calls: number; errors: number }>();
	const thinkGaps: number[] = [];
	let first: number | undefined;
	let last: number | undefined;
	let toolS = 0;
	let idleS = 0;
	let modelCalls = 0;
	let outputTokens = 0;
	let lastResult: number | undefined;
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
		if (last !== undefined && at - last > IDLE_S) idleS += at - last;
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
				toolS += at - began;
			}
			row.calls++;
			if (entry.message.isError) row.errors++;
			tools.set(name, row);
		}
	}
	const wallS = first !== undefined && last !== undefined ? last - first : 0;
	return { wallS, modelS: Math.max(0, wallS - toolS - idleS), idleS, modelCalls, outputTokens, tools, thinkGaps };
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

const minutes = (s: number): string => `${(s / 60).toFixed(1)} min`;

export function report(label: string, result: Pace): string {
	const toolS = [...result.tools.values()].reduce((sum, row) => sum + row.seconds, 0);
	const out = [
		`== ${label}`,
		`wall ${minutes(result.wallS)} = model ${minutes(result.modelS)} (${result.modelCalls} calls, median ${percentile(result.thinkGaps, 0.5).toFixed(1)} s, p90 ${percentile(result.thinkGaps, 0.9).toFixed(1)} s, ${Math.round(result.outputTokens / 1000)}k output tokens) + tools ${minutes(toolS)} + idle ${minutes(result.idleS)}`,
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
