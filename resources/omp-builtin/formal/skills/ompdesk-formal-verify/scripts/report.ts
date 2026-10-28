#!/usr/bin/env bun
// Renders findings files (schema: assets/findings.schema.json) into self-contained HTML pages: inline CSS, no
// script, every piece of model text escaped. One page per concern.
//
//   bun report.ts <findings.json | folder>... [--out file.html] [--out-dir DIR]
//
// Several concerns: pass several files (`formal/findings.<concern>.json`), a folder (its `findings.json`,
// `findings.*.json` and `<subfolder>/findings.json`), or one file whose top level is `{"concerns": [ {...}, {...} ]}`.
// Default output folder: `reports/` beside the nearest `manifest.json` above the findings file (so `formal/reports/`
// for every concern of a repo), else beside the findings file. A trace row in the shape `tlc.ts --json` writes under
// `rows` is accepted and converted.
//
// Show a page with OMPdesk's `gui_visualize` tool (Preview panel) when that tool exists; otherwise name the path.
// Exit: 0 written, 2 usage, a findings file invalid, or assets/findings.schema.json unreadable.
import fs from "node:fs";
import path from "node:path";
import { concernDocuments, normalizeFindings } from "./lib/findings";
import { isRecord, readJson } from "./lib/json";
import { EXIT, UsageError } from "./lib/proc";
import { renderReport } from "./lib/report-render";
import { validate } from "./lib/schema";
import { skillDir } from "./lib/toolchain";

const USAGE = "usage: bun report.ts <findings.json | folder>... [--out file.html] [--out-dir DIR]";

export interface Args {
	inputs: string[];
	out?: string;
	outDir?: string;
}

export function parseArgs(argv: string[]): Args {
	const inputs: string[] = [];
	let out: string | undefined;
	let outDir: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--out") {
			out = argv[++i];
			if (!out) throw new UsageError(`--out needs a file name\n${USAGE}`);
		} else if (arg === "--out-dir") {
			outDir = argv[++i];
			if (!outDir) throw new UsageError(`--out-dir needs a folder\n${USAGE}`);
		} else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}\n${USAGE}`);
		else inputs.push(arg);
	}
	if (inputs.length === 0) throw new UsageError(USAGE);
	if (out && outDir) throw new UsageError(`--out and --out-dir are exclusive\n${USAGE}`);
	return { inputs, ...(out ? { out } : {}), ...(outDir ? { outDir } : {}) };
}

/** The findings files a folder holds: `findings.json`, `findings.<concern>.json`, and `<subfolder>/findings.json`. */
export function findingsInFolder(dir: string): string[] {
	const found: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isFile() && /^findings(?:\..+)?\.json$/.test(entry.name)) found.push(path.join(dir, entry.name));
		else if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "findings.json")))
			found.push(path.join(dir, entry.name, "findings.json"));
	}
	return found;
}

/** `reports/` beside the nearest `manifest.json` above the file (the formal folder), else beside the file. */
export function defaultReportsDir(findingsFile: string): string {
	const start = path.dirname(path.resolve(findingsFile));
	for (let dir = start; ; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "manifest.json"))) return path.join(dir, "reports");
		if (path.dirname(dir) === dir) return path.join(start, "reports");
	}
}

export function main(argv: string[]): number {
	let args: Args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return EXIT.usage;
	}
	const files: string[] = [];
	for (const input of args.inputs) {
		const resolved = path.resolve(input);
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			const inside = findingsInFolder(resolved);
			if (inside.length === 0) {
				console.error(`no findings.json or findings.<concern>.json in ${resolved}`);
				return EXIT.usage;
			}
			files.push(...inside);
		} else files.push(resolved);
	}
	const schemaFile = path.join(skillDir(), "assets", "findings.schema.json");
	let schema: unknown;
	try {
		schema = readJson(schemaFile);
	} catch (error) {
		console.error(`cannot read ${schemaFile}: ${error instanceof Error ? error.message : String(error)}`);
		return EXIT.usage;
	}
	const pages: { file: string; concern: string; data: Record<string, unknown>; source: string }[] = [];
	for (const file of files) {
		let raw: unknown;
		try {
			raw = readJson(file);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			return EXIT.usage;
		}
		for (const { where, doc } of concernDocuments(raw)) {
			const data = normalizeFindings(doc);
			const problems = validate(data, schema);
			if (problems.length > 0 || !isRecord(data)) {
				console.error(`${file}${where ? ` ${where}` : ""} does not match assets/findings.schema.json:`);
				for (const problem of problems.slice(0, 25)) console.error(`  ${problem}`);
				return EXIT.usage;
			}
			pages.push({
				file,
				concern: String(data.concern).replace(/[^\w.-]+/g, "-"),
				data,
				source: `${file}${where ? ` ${where}` : ""}`,
			});
		}
	}
	if (args.out && pages.length !== 1) {
		console.error(`--out names one file but ${pages.length} concerns were given: use --out-dir`);
		return EXIT.usage;
	}
	const targets = new Map<string, string>();
	for (const page of pages) {
		const out = path.resolve(
			args.out ?? path.join(args.outDir ?? defaultReportsDir(page.file), `${page.concern}.html`),
		);
		const clash = targets.get(out);
		if (clash) {
			console.error(`${clash} and ${page.source} are both concern "${page.concern}": they would write ${out}`);
			return EXIT.usage;
		}
		targets.set(out, page.source);
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, renderReport(page.data));
		console.log(`wrote ${out}`);
	}
	console.log(
		"Show it with the gui_visualize tool (Preview panel) when it exists; otherwise give the user this path.",
	);
	return EXIT.ok;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
