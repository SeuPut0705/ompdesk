#!/usr/bin/env bun
// Renders formal/findings.json (schema: assets/findings.schema.json) into one self-contained HTML page: inline
// CSS, no script, every piece of model text escaped. Default output: <folder of findings.json>/reports/<concern>.html.
//
//   bun report.ts <findings.json> [--out file.html]
//
// Show the page with OMPdesk's `gui_visualize` tool (Preview panel) when that tool exists; otherwise name the path.
// Exit: 0 written, 2 usage or findings.json invalid.
import fs from "node:fs";
import path from "node:path";
import { isRecord, readJson } from "./lib/json";
import { EXIT, UsageError } from "./lib/proc";
import { renderReport } from "./lib/report-render";
import { validate } from "./lib/schema";
import { skillDir } from "./lib/toolchain";

const USAGE = "usage: bun report.ts <findings.json> [--out file.html]";

export interface Args {
	findings: string;
	out?: string;
}

export function parseArgs(argv: string[]): Args {
	let findings: string | undefined;
	let out: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--out") {
			out = argv[++i];
			if (!out) throw new UsageError(`--out needs a file name\n${USAGE}`);
		} else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}\n${USAGE}`);
		else if (!findings) findings = arg;
		else throw new UsageError(`unexpected argument ${arg}\n${USAGE}`);
	}
	if (!findings) throw new UsageError(USAGE);
	return { findings, ...(out ? { out } : {}) };
}

export function main(argv: string[]): number {
	let args: Args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return EXIT.usage;
	}
	let data: unknown;
	try {
		data = readJson(path.resolve(args.findings));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return EXIT.usage;
	}
	const schema = readJson(path.join(skillDir(), "assets", "findings.schema.json"));
	const problems = validate(data, schema);
	if (problems.length > 0 || !isRecord(data)) {
		console.error(`${args.findings} does not match assets/findings.schema.json:`);
		for (const problem of problems.slice(0, 25)) console.error(`  ${problem}`);
		return EXIT.usage;
	}
	const concern = String(data.concern).replace(/[^\w.-]+/g, "-");
	const out = path.resolve(
		args.out ?? path.join(path.dirname(path.resolve(args.findings)), "reports", `${concern}.html`),
	);
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, renderReport(data));
	console.log(`wrote ${out}`);
	console.log(
		"Show it with the gui_visualize tool (Preview panel) when it exists; otherwise give the user this path.",
	);
	return EXIT.ok;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
