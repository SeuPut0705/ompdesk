/**
 * Where a session's wall time went: model generation against tool execution, by tool, with call and error counts.
 * The rules live in `src/main/session-pace.ts` (the same ones behind the `Pace:` line of a child's done report).
 *
 *   bun scripts/session-pace.ts <session.jsonl> [more.jsonl…]
 *   bun scripts/session-pace.ts --latest [N]        the N (default 3) most recently changed sessions under ~/.omp
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Pace, pace, paceLine, percentile } from "../src/main/session-pace";

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
