#!/usr/bin/env bun
// Reruns every model listed in <formal dir>/manifest.json, for CI and for the next agent: the TLC matrix (or the
// configs that must pass) or the Lean build and trust audit, then the mutation run, whether every `@code` tag still
// points at a real file and line, and whether the covered files changed since the model's sync commit.
//
//   bun verify-all.ts <formal dir> [--only id] [--stamp] [--strict-drift] [--skip-mutations]
//
//   --stamp         after a model passed everything, write the current HEAD into its `syncCommit`
//                   (refused while the covered files have uncommitted changes)
//   --strict-drift  covered files changed since the sync commit, or no sync commit yet, fail the run
//
// Exit: 0 all passed, 1 a check ran and failed (or strict drift), 2 usage or bad manifest, 3 UNAVAILABLE (a tool
// could not be prepared: not checked) when nothing failed.
import fs from "node:fs";
import path from "node:path";
import { main as leanMain } from "./lean-check";
import { checkTags, extractTags } from "./lib/code-tags";
import { checkDrift, git, hasUncommitted } from "./lib/drift";
import { readJson } from "./lib/json";
import { type Manifest, type ModelEntry, parseManifest } from "./lib/manifest";
import { EXIT, UsageError } from "./lib/proc";
import { main as mutateMain } from "./mutate";
import { main as tlcMain } from "./tlc";

const USAGE = "usage: bun verify-all.ts <formal dir> [--only id] [--stamp] [--strict-drift] [--skip-mutations]";

export interface Args {
	dir: string;
	only?: string;
	stamp: boolean;
	strictDrift: boolean;
	skipMutations: boolean;
}

export function parseArgs(argv: string[]): Args {
	const args: Args = { dir: "", stamp: false, strictDrift: false, skipMutations: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--only") {
			const id = argv[++i];
			if (!id) throw new UsageError(`--only needs a model id\n${USAGE}`);
			args.only = id;
		} else if (arg === "--stamp") args.stamp = true;
		else if (arg === "--strict-drift") args.strictDrift = true;
		else if (arg === "--skip-mutations") args.skipMutations = true;
		else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}\n${USAGE}`);
		else if (!args.dir) args.dir = arg;
		else throw new UsageError(`unexpected argument ${arg}\n${USAGE}`);
	}
	if (!args.dir) throw new UsageError(USAGE);
	return args;
}

type Verdict = "pass" | "fail" | "unavailable" | "skipped";

interface ModelResult {
	id: string;
	checks: { name: string; verdict: Verdict; note?: string }[];
}

function verdictOf(code: number): Verdict {
	return code === EXIT.ok ? "pass" : code === EXIT.unavailable ? "unavailable" : "fail";
}

function modelFiles(dir: string, extension: string): string[] {
	const out: string[] = [];
	const walk = (folder: string): void => {
		for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
			if ([".lake", ".git", "node_modules", ".tlc-out", "states"].includes(entry.name)) continue;
			const full = path.join(folder, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(extension)) out.push(full);
		}
	};
	walk(dir);
	return out;
}

async function verifyModel(model: ModelEntry, formalDir: string, codeRoot: string, args: Args): Promise<ModelResult> {
	const dir = path.resolve(formalDir, model.dir);
	const result: ModelResult = { id: model.id, checks: [] };
	const add = (name: string, verdict: Verdict, note?: string): void => {
		result.checks.push({ name, verdict, ...(note ? { note } : {}) });
		console.log(
			`${verdict === "pass" ? "ok  " : verdict === "skipped" ? "skip" : verdict === "unavailable" ? "NOT CHECKED" : "FAIL"}  ${model.id}: ${name}${note ? ` - ${note}` : ""}`,
		);
	};
	console.log(`\n== ${model.id}${model.title ? `: ${model.title}` : ""} (${model.kind})`);
	if (!fs.existsSync(dir)) {
		add("model folder", "fail", `${model.dir} does not exist`);
		return result;
	}
	if (model.kind === "tla") {
		const spec = path.join(dir, model.spec as string);
		if (!fs.existsSync(spec)) {
			add("spec", "fail", `${model.spec} does not exist`);
			return result;
		}
		if (model.matrix) add("TLC matrix", verdictOf(await tlcMain([spec, "--matrix", path.join(dir, model.matrix)])));
		else {
			for (const config of model.configs ?? [`${path.basename(spec, ".tla")}.cfg`]) {
				add(`TLC ${config}`, verdictOf(await tlcMain([spec, "--config", path.join(dir, config)])));
			}
		}
	} else {
		const project = path.resolve(dir, model.project ?? ".");
		add("Lean build and trust audit", verdictOf(await leanMain([project])));
	}
	if (model.mutations && !args.skipMutations) {
		const target = model.kind === "tla" ? model.spec : model.model;
		if (!target) add("mutations", "fail", 'a lean model with mutations needs a "model" file');
		else add("mutations", verdictOf(await mutateMain([path.join(dir, target), path.join(dir, model.mutations)])));
	} else if (model.mutations) add("mutations", "skipped", "--skip-mutations");
	const extension = model.kind === "tla" ? ".tla" : ".lean";
	const problems = modelFiles(dir, extension).flatMap(file =>
		checkTags(extractTags(fs.readFileSync(file, "utf8")), file, codeRoot),
	);
	for (const problem of problems)
		console.log(`      @code ${path.relative(formalDir, problem.file)}:${problem.tag.line}: ${problem.problem}`);
	add(
		"@code tags resolve",
		problems.length === 0 ? "pass" : "fail",
		problems.length ? `${problems.length} unresolved` : undefined,
	);
	const drift = await checkDrift(codeRoot, model.covers, model.syncCommit);
	for (const file of drift.files) console.log(`      changed since sync: ${file}`);
	if (drift.status === "ok") add("drift", "pass", drift.message);
	else if (drift.status === "no-covers" || drift.status === "unstamped")
		add("drift", args.strictDrift && drift.status === "unstamped" ? "fail" : "skipped", drift.message);
	else add("drift", drift.status === "drift" && !args.strictDrift ? "pass" : "fail", drift.message);
	return result;
}

export async function main(argv: string[]): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return EXIT.usage;
	}
	const formalDir = path.resolve(args.dir);
	const manifestFile = path.join(formalDir, "manifest.json");
	let manifest: Manifest;
	try {
		manifest = parseManifest(readJson(manifestFile));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return EXIT.usage;
	}
	const models = args.only ? manifest.models.filter(model => model.id === args.only) : manifest.models;
	if (models.length === 0) {
		console.error(`no model ${args.only} in ${manifestFile} (${manifest.models.map(model => model.id).join(", ")})`);
		return EXIT.usage;
	}
	const codeRoot = path.resolve(formalDir, manifest.codeRoot);
	const results: ModelResult[] = [];
	for (const model of models) results.push(await verifyModel(model, formalDir, codeRoot, args));
	const failed = results.some(result => result.checks.some(check => check.verdict === "fail"));
	const unavailable = results.some(result => result.checks.some(check => check.verdict === "unavailable"));
	if (args.stamp) {
		const head = await git(codeRoot, ["rev-parse", "HEAD"]);
		if (!head.ok) console.log(`\nstamp: cannot read HEAD of ${codeRoot}: ${head.out}`);
		else {
			let wrote = false;
			const raw = readJson(manifestFile) as { models: { id: string; syncCommit?: string | null }[] };
			for (const result of results) {
				const model = models.find(candidate => candidate.id === result.id) as ModelEntry;
				const clean = result.checks.every(check => check.verdict === "pass" || check.verdict === "skipped");
				const dirty = await hasUncommitted(codeRoot, model.covers);
				if (!clean) console.log(`\nstamp: ${result.id} not stamped (a check did not pass)`);
				else if (dirty)
					console.log(
						`\nstamp: ${result.id} not stamped (covered files have uncommitted changes: commit them first)`,
					);
				else {
					const entry = raw.models.find(candidate => candidate.id === result.id);
					if (entry) {
						entry.syncCommit = head.out;
						wrote = true;
						console.log(`\nstamp: ${result.id} syncCommit = ${head.out.slice(0, 10)}`);
					}
				}
			}
			if (wrote) fs.writeFileSync(manifestFile, `${JSON.stringify(raw, null, "\t")}\n`);
		}
	}
	console.log("");
	for (const result of results) {
		const bad = result.checks.filter(check => check.verdict === "fail" || check.verdict === "unavailable");
		console.log(
			`${bad.length === 0 ? "PASS" : "FAIL"}  ${result.id}: ${result.checks.length - bad.length} of ${result.checks.length} checks ok${bad.length ? ` (${bad.map(check => check.name).join(", ")})` : ""}`,
		);
	}
	if (failed) return EXIT.failed;
	return unavailable ? EXIT.unavailable : EXIT.ok;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
