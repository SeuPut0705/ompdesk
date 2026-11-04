/**
 * Where a session's wall time went: model generation against tool execution, by tool, with call and error counts.
 * The rules live in `src/main/session-pace.ts` (the same ones behind the `Pace:` line of a child's done report).
 *
 *   bun scripts/session-pace.ts <session.jsonl> [more.jsonl…]
 *   bun scripts/session-pace.ts --latest [N]        the N (default 3) most recently changed sessions under ~/.omp
 *   bun scripts/session-pace.ts --days [N]          one table row per session changed in the last N (default 7) days
 *                                                   with 20 model calls or more, advisor journals left out
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Pace, pace, paceLine, percentile, toolCalls, toolErrors, waste } from "../src/main/session-pace";

const minutes = (s: number): string => `${(s / 60).toFixed(1)} min`;

export function report(label: string, result: Pace): string {
	const out = [
		`== ${label}`,
		`wall ${minutes(result.wallS)} = model+between-calls ${minutes(result.modelS)} (${result.modelCalls} calls, median ${percentile(result.thinkGaps, 0.5).toFixed(1)} s, p90 ${percentile(result.thinkGaps, 0.9).toFixed(1)} s, ${Math.round(result.outputTokens / 1000)}k output tokens) + tools ${minutes(result.toolS)} + idle ${minutes(result.idleS)}`,
		paceLine(result),
	];
	const rows = Object.entries(result.tools).sort((a, b) => b[1].seconds - a[1].seconds);
	for (const [name, row] of rows)
		out.push(
			`   ${name.padEnd(10)} ${minutes(row.seconds).padStart(9)}  calls ${String(row.calls).padStart(4)}  errors ${row.errors}`,
		);
	return out.join("\n");
}

const SESSIONS = path.join(os.homedir(), ".omp", "agent", "sessions");

function journals(): { file: string; mtime: number }[] {
	const files: { file: string; mtime: number }[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".jsonl")) files.push({ file: full, mtime: fs.statSync(full).mtimeMs });
		}
	};
	walk(SESSIONS);
	return files.sort((a, b) => b.mtime - a.mtime);
}

function latest(n: number): string[] {
	return journals()
		.slice(0, n)
		.map(entry => entry.file);
}

/** One row per session: the numbers a brief writer compares across sessions. */
export function sweep(days: number): string {
	const since = Date.now() - days * 86_400_000;
	const rows: string[] = [];
	const sum = { wall: 0, model: 0, tool: 0, idle: 0, calls: 0, toolCalls: 0, errors: 0, polls: 0, n: 0 };
	for (const { file, mtime } of journals()) {
		if (mtime < since || path.basename(file).startsWith("__")) continue;
		const result = pace(fs.readFileSync(file, "utf8").split("\n"));
		if (result.modelCalls < 20) continue;
		const label = path.relative(SESSIONS, file).replace(/^-/, "").slice(0, 44);
		rows.push(
			[
				label.padEnd(44),
				minutes(result.wallS).padStart(10),
				minutes(result.modelS).padStart(10),
				minutes(result.toolS).padStart(9),
				minutes(result.idleS).padStart(10),
				String(result.modelCalls).padStart(6),
				String(toolCalls(result)).padStart(6),
				`${percentile(result.thinkGaps, 0.5).toFixed(1)}s`.padStart(7),
				String(toolErrors(result)).padStart(5),
				String(result.polls).padStart(6),
				waste(result) ?? "",
			].join(" "),
		);
		sum.wall += result.wallS;
		sum.model += result.modelS;
		sum.tool += result.toolS;
		sum.idle += result.idleS;
		sum.calls += result.modelCalls;
		sum.toolCalls += toolCalls(result);
		sum.errors += toolErrors(result);
		sum.polls += result.polls;
		sum.n++;
	}
	const head = [
		"session".padEnd(44),
		"wall".padStart(10),
		"model".padStart(10),
		"tools".padStart(9),
		"idle".padStart(10),
		"calls".padStart(6),
		"tools#".padStart(6),
		"median".padStart(7),
		"errs".padStart(5),
		"polls".padStart(6),
		"waste",
	].join(" ");
	const total = `${sum.n} sessions: wall ${minutes(sum.wall)} = model ${minutes(sum.model)} + tools ${minutes(sum.tool)} + idle ${minutes(sum.idle)}; ${sum.calls} model calls over ${sum.toolCalls} tool calls, ${sum.errors} tool errors, ${sum.polls} polls`;
	return [head, ...rows, total].join("\n");
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args[0] === "--days") {
		console.log(sweep(Number(args[1] ?? 7)));
		process.exit(0);
	}
	const files = args[0] === "--latest" ? latest(Number(args[1] ?? 3)) : args;
	if (files.length === 0) {
		console.error("usage: bun scripts/session-pace.ts <session.jsonl>… | --latest [N] | --days [N]");
		process.exit(2);
	}
	for (const file of files) {
		const lines = fs.readFileSync(file, "utf8").split("\n");
		console.log(report(path.relative(path.join(os.homedir(), ".omp", "agent", "sessions"), file), pace(lines)));
	}
}
