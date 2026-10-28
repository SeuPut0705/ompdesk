#!/usr/bin/env bun
// Builds a Lean 4 (lake) project and audits its trust base: FAIL on `sorry`/`admit`, user `axiom`s,
// `native_decide` (unless --allow-native) and any theorem that depends on an axiom beyond propext,
// Classical.choice and Quot.sound. A build error is attributed to the theorem it sits in.
//
//   bun lean-check.ts <lake project dir> [files.lean ...] [--allow-native] [--module Root ...] [--json]
//
// Exit: 0 clean, 1 a check ran and failed, 2 usage, 3 UNAVAILABLE (Lean could not be prepared: not checked).
import path from "node:path";
import { checkLean, type LeanCheck } from "./lib/lean-trust";
import { EXIT, UsageError } from "./lib/proc";

const USAGE =
	"usage: bun lean-check.ts <lake project dir> [files.lean ...] [--allow-native] [--module Root ...] [--json]";

export interface Args {
	project: string;
	files: string[];
	allowNative: boolean;
	roots: string[];
	json: boolean;
}

export function parseArgs(argv: string[]): Args {
	const args: Args = { project: "", files: [], allowNative: false, roots: [], json: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--allow-native") args.allowNative = true;
		else if (arg === "--json") args.json = true;
		else if (arg === "--module" || arg === "--prefix") {
			const value = argv[++i];
			if (!value) throw new UsageError(`${arg} needs a module name\n${USAGE}`);
			args.roots.push(value);
		} else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}\n${USAGE}`);
		else if (!args.project) args.project = arg;
		else if (arg.endsWith(".lean")) args.files.push(arg);
		else throw new UsageError(`unexpected argument ${arg} (files end in .lean)\n${USAGE}`);
	}
	if (!args.project) throw new UsageError(USAGE);
	return args;
}

export function render(check: LeanCheck, project: string): string[] {
	const out: string[] = [];
	if (check.status === "unavailable") {
		out.push(`UNAVAILABLE  Lean could not be prepared: ${check.detail}`);
		out.push(
			"  Report this check as not run. Retry with network access, or install elan and set OMPDESK_FORMAL_SYSTEM_LEAN=1.",
		);
		return out;
	}
	const advisories = check.findings.filter(finding => !finding.blocking);
	out.push(
		`${check.status === "pass" ? "PASS" : "FAIL"}  lake build ${check.buildOk ? "succeeded" : "failed"}  ${check.toolchain ?? ""}`.trimEnd(),
	);
	for (const line of check.detail.split("\n").filter(Boolean)) out.push(`  ${line}`);
	for (const finding of advisories)
		out.push(`  review: ${finding.kind} at ${finding.file}:${finding.line}: ${finding.text}`);
	if (check.theorems.length > 0) {
		const bad = check.theorems.filter(theorem => theorem.flag).length;
		out.push(`${check.theorems.length} theorems audited under ${path.basename(project)}, ${bad} with trust problems`);
		for (const theorem of check.theorems) {
			out.push(`  ${(theorem.flag ?? "ok").padEnd(6)} ${theorem.name}  [${theorem.axioms.join(", ")}]`);
		}
	}
	return out;
}

export async function main(argv: string[]): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return EXIT.usage;
	}
	const check = await checkLean(path.resolve(args.project), {
		files: args.files,
		allowNative: args.allowNative,
		roots: args.roots,
	});
	if (args.json) console.log(JSON.stringify({ ...check, log: undefined }, null, 2));
	else for (const line of render(check, args.project)) console.log(line);
	if (check.status === "unavailable") return EXIT.unavailable;
	return check.status === "pass" ? EXIT.ok : EXIT.failed;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
