#!/usr/bin/env bun
// Proves that each property of a model can fail. Every mutation (a search/replace pair that breaks one thing,
// such as dropping a guard) is applied to a temp copy of the model and the checker is rerun: DETECTED when the
// checker fails on the property the mutation says it breaks, MISSED when the model still passes, UNCOVERED for a
// property no mutation targets, INVALID when the mutation does not apply or the mutated model is not checkable.
//
//   bun mutate.ts <model file> <mutations.json> [--keep] [--json]
//
// Exit: 0 all detected and every property covered, 1 MISSED / UNCOVERED / baseline fails, 2 usage or INVALID,
// 3 UNAVAILABLE (the checker could not be prepared: not checked).
import fs from "node:fs";
import path from "node:path";
import { cfgProperties, checkerRoot, makeChecker } from "./lib/checkers";
import { readJson } from "./lib/json";
import {
	type MutationReport,
	type MutationSpec,
	mutationExitCode,
	parseMutations,
	runMutations,
} from "./lib/mutate-core";
import { EXIT, UsageError } from "./lib/proc";

const USAGE = "usage: bun mutate.ts <model file> <mutations.json> [--keep] [--json]";

export interface Args {
	model: string;
	mutations: string;
	keep: boolean;
	json: boolean;
}

export function parseArgs(argv: string[]): Args {
	const rest: string[] = [];
	let keep = false;
	let json = false;
	for (const arg of argv) {
		if (arg === "--keep") keep = true;
		else if (arg === "--json") json = true;
		else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}\n${USAGE}`);
		else rest.push(arg);
	}
	if (rest.length !== 2) throw new UsageError(USAGE);
	return { model: rest[0] as string, mutations: rest[1] as string, keep, json };
}

export function render(report: MutationReport): string[] {
	const out: string[] = [];
	if (report.unavailable) {
		out.push("UNAVAILABLE  the checker could not be prepared; no mutation was judged. Report this as not checked.");
		return out;
	}
	out.push(
		`baseline: ${report.baseline.status === "pass" ? "pass" : `${report.baseline.status.toUpperCase()}: ${report.baseline.detail}`}`,
	);
	if (report.baseline.status !== "pass") {
		out.push("The unmutated model must pass before mutations mean anything.");
		return out;
	}
	for (const result of report.results) out.push(`${result.status.padEnd(8)} ${result.name}: ${result.detail}`);
	for (const property of report.properties) {
		if (property.status === "covered") out.push(`covered  ${property.name} (by ${property.by.join(", ")})`);
		else if (property.status === "WAIVED") out.push(`WAIVED   ${property.name}: ${property.reason}`);
		else out.push(`UNCOVERED ${property.name}: no mutation makes it fail, so nothing shows it can`);
	}
	const detected = report.results.filter(result => result.status === "DETECTED").length;
	out.push(`${detected} of ${report.results.length} mutations detected`);
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
	const model = path.resolve(args.model);
	if (!fs.existsSync(model)) {
		console.error(`model not found: ${model}`);
		return EXIT.usage;
	}
	let spec: MutationSpec;
	try {
		spec = parseMutations(readJson(path.resolve(args.mutations)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return EXIT.usage;
	}
	const root = checkerRoot(spec.checker, path.dirname(model), path.dirname(path.resolve(args.mutations)));
	if (path.relative(root, model).startsWith("..")) {
		console.error(`the model ${model} is not inside the checker root ${root}`);
		return EXIT.usage;
	}
	let properties = spec.properties;
	if (!properties) {
		const config = path.join(
			path.dirname(model),
			spec.checker.kind === "tlc" && spec.checker.config
				? spec.checker.config
				: `${path.basename(model, ".tla")}.cfg`,
		);
		if (!fs.existsSync(config)) {
			console.error(`config not found: ${config} (name the properties in the mutations file)`);
			return EXIT.usage;
		}
		properties = cfgProperties(config);
	}
	const report = await runMutations({
		root,
		model,
		spec,
		properties,
		check: makeChecker(spec.checker),
		keep: args.keep,
	});
	if (args.json) console.log(JSON.stringify({ ...report, exit: mutationExitCode(report) }, null, 2));
	else for (const line of render(report)) console.log(line);
	if (args.keep) console.error(`kept the mutated copies in ${report.workDir}`);
	return mutationExitCode(report);
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
