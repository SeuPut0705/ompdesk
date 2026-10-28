#!/usr/bin/env bun
// Reruns every model listed in <formal dir>/manifest.json, for CI and for the next agent: the TLC matrix (or the
// configs that must pass) or the Lean build and trust audit, then the mutation run, whether every `@code` tag still
// points at a real file and line, and whether the covered files changed since the model's sync commit.
//
//   bun verify-all.ts <formal dir> [--tier fast|deep] [--only id] [--stamp [--allow-dirty]] [--strict-drift]
//                     [--skip-mutations]
//
//   --tier fast     (default: the inner loop and every PR) the models whose tier is `fast`
//   --tier deep     (scheduled runs) every model, `fast` and `deep`
//                   A model's tier is its manifest `tier`; an id ending in `-deep` is `deep` unless it says otherwise.
//                   `--only <id>` runs that model whatever its tier.
//   --stamp         after a model passed everything, write the current HEAD into its `syncCommit`. The sha only has
//                   to hold the covered code: the model files may be uncommitted or not exist at it. Refused while
//                   the covered code (the covered functions and ranges, not whole files) has uncommitted changes
//   --allow-dirty   with --stamp: stamp those uncommitted changes too (HEAD plus a `syncDiff` digest of the covered
//                   code), for when the task forbids committing. The model is in sync while the covered code equals
//                   what was stamped, committed or not
//   --strict-drift  covered code changed since the sync commit, or no sync commit yet, fail the run
//
// Exit: 0 all passed, 1 a check ran and failed (or strict drift), 2 usage or bad manifest, 3 UNAVAILABLE (a tool
// could not be prepared: not checked) when nothing failed.
import fs from "node:fs";
import path from "node:path";
import { main as leanMain } from "./lean-check";
import { checkTags, extractTags } from "./lib/code-tags";
import { checkDrift, git, hasUncommitted, stampDigest } from "./lib/drift";
import { readJson } from "./lib/json";
import { type Manifest, type ModelEntry, parseManifest, tierOf } from "./lib/manifest";
import { EXIT, UsageError } from "./lib/proc";
import { main as mutateMain } from "./mutate";
import { main as tlcMain } from "./tlc";

const USAGE =
	"usage: bun verify-all.ts <formal dir> [--tier fast|deep] [--only id] [--stamp [--allow-dirty]] [--strict-drift] [--skip-mutations]";

export interface Args {
	dir: string;
	only?: string;
	stamp: boolean;
	allowDirty: boolean;
	tier: "fast" | "deep";
	strictDrift: boolean;
	skipMutations: boolean;
}

export function parseArgs(argv: string[]): Args {
	const args: Args = {
		dir: "",
		stamp: false,
		allowDirty: false,
		tier: "fast",
		strictDrift: false,
		skipMutations: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--only") {
			const id = argv[++i];
			if (!id) throw new UsageError(`--only needs a model id\n${USAGE}`);
			args.only = id;
		} else if (arg === "--tier") {
			const tier = argv[++i];
			if (tier !== "fast" && tier !== "deep") throw new UsageError(`--tier is fast or deep\n${USAGE}`);
			args.tier = tier;
		} else if (arg === "--stamp") args.stamp = true;
		else if (arg === "--allow-dirty") args.allowDirty = true;
		else if (arg === "--strict-drift") args.strictDrift = true;
		else if (arg === "--skip-mutations") args.skipMutations = true;
		else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}\n${USAGE}`);
		else if (!args.dir) args.dir = arg;
		else throw new UsageError(`unexpected argument ${arg}\n${USAGE}`);
	}
	if (!args.dir) throw new UsageError(USAGE);
	if (args.allowDirty && !args.stamp) throw new UsageError(`--allow-dirty goes with --stamp\n${USAGE}`);
	return args;
}

/** `drift` passes the run (a prompt to look, not a failure) but is never printed as `ok`. */
export type Verdict = "pass" | "fail" | "unavailable" | "skipped" | "drift";

export interface ModelResult {
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
			`${verdict === "pass" ? "ok  " : verdict === "skipped" ? "skip" : verdict === "unavailable" ? "NOT CHECKED" : verdict === "drift" ? "DRIFT" : "FAIL"}  ${model.id}: ${name}${note ? ` - ${note}` : ""}`,
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
	const drift = await checkDrift(codeRoot, model.covers, model.syncCommit, model.syncDiff);
	for (const file of drift.files) console.log(`      changed since sync: ${file}`);
	if (drift.status === "ok") add("drift", "pass", drift.message);
	else if (drift.status === "no-covers" || drift.status === "unstamped")
		add("drift", args.strictDrift && drift.status === "unstamped" ? "fail" : "skipped", drift.message);
	else if (drift.status === "no-git") add("drift", "unavailable", drift.message);
	else add("drift", drift.status === "drift" && !args.strictDrift ? "drift" : "fail", drift.message);
	return result;
}

/**
 * Writes the current HEAD into the `syncCommit` of every model that passed everything. HEAD only has to hold the
 * covered code: the model files may be uncommitted or not exist at it. A model whose covered code (its functions and
 * ranges, not whole files) has uncommitted changes is stamped only with `allowDirty`, and then also gets `syncDiff`.
 */
export async function stampModels(
	codeRoot: string,
	manifestFile: string,
	models: ModelEntry[],
	results: ModelResult[],
	allowDirty: boolean,
): Promise<void> {
	const head = await git(codeRoot, ["rev-parse", "HEAD"]);
	if (!head.ok) {
		console.log(`\nstamp: cannot read HEAD of ${codeRoot}: ${head.err || head.out}`);
		return;
	}
	let wrote = false;
	const raw = readJson(manifestFile) as {
		models: { id: string; syncCommit?: string | null; syncDiff?: string }[];
	};
	for (const result of results) {
		const model = models.find(candidate => candidate.id === result.id) as ModelEntry;
		const clean = result.checks.every(
			check => check.verdict === "pass" || check.verdict === "skipped" || check.verdict === "drift",
		);
		const dirty = await hasUncommitted(codeRoot, model.covers);
		if (!clean) console.log(`\nstamp: ${result.id} not stamped (a check did not pass)`);
		else if (dirty && !allowDirty)
			console.log(
				`\nstamp: ${result.id} not stamped: the covered code has uncommitted changes, so HEAD does not describe it. Commit them (when you may), or rerun with --stamp --allow-dirty to stamp HEAD plus those changes (references/persist.md, "The sync commit").`,
			);
		else {
			const entry = raw.models.find(candidate => candidate.id === result.id);
			if (!entry) continue;
			if (result.checks.find(check => check.name === "drift")?.verdict === "drift") {
				console.log(
					`\nstamp: NOTE ${result.id}: covered code changed since its old syncCommit. Stamping says you checked the model against it: do that first (references/persist.md, steps 3 and 4).`,
				);
			}
			entry.syncCommit = head.out;
			if (dirty) {
				entry.syncDiff = await stampDigest(codeRoot, model.covers, head.out);
				console.log(
					`\nstamp: ${result.id} syncCommit = ${head.out.slice(0, 10)} + uncommitted covered changes (syncDiff ${entry.syncDiff.slice(0, 10)}): in sync while the covered code stays as it is now`,
				);
			} else {
				delete entry.syncDiff;
				console.log(`\nstamp: ${result.id} syncCommit = ${head.out.slice(0, 10)}`);
			}
			wrote = true;
		}
	}
	if (wrote) fs.writeFileSync(manifestFile, `${JSON.stringify(raw, null, "\t")}\n`);
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
	const models = args.only
		? manifest.models.filter(model => model.id === args.only)
		: manifest.models.filter(model => args.tier === "deep" || tierOf(model) === "fast");
	if (models.length === 0) {
		console.error(
			args.only
				? `no model ${args.only} in ${manifestFile} (${manifest.models.map(model => model.id).join(", ")})`
				: `no ${args.tier}-tier model in ${manifestFile} (${manifest.models.map(model => `${model.id}: ${tierOf(model)}`).join(", ")})`,
		);
		return EXIT.usage;
	}
	if (!args.only) {
		const left = manifest.models.filter(model => !models.includes(model));
		console.log(
			`tier ${args.tier}: ${models.map(model => model.id).join(", ")}${left.length ? `  (not run: ${left.map(model => `${model.id} [${tierOf(model)}]`).join(", ")}; --tier deep runs them)` : ""}`,
		);
	}
	const codeRoot = path.resolve(formalDir, manifest.codeRoot);
	const results: ModelResult[] = [];
	for (const model of models) results.push(await verifyModel(model, formalDir, codeRoot, args));
	const failed = results.some(result => result.checks.some(check => check.verdict === "fail"));
	const unavailable = results.some(result => result.checks.some(check => check.verdict === "unavailable"));
	if (args.stamp) await stampModels(codeRoot, manifestFile, models, results, args.allowDirty);
	console.log("");
	for (const result of results) {
		const bad = result.checks.filter(check => check.verdict === "fail" || check.verdict === "unavailable");
		const label = bad.length === 0 ? "PASS" : bad.some(check => check.verdict === "fail") ? "FAIL" : "NOT CHECKED";
		console.log(
			`${label}  ${result.id}: ${result.checks.length - bad.length} of ${result.checks.length} checks ok${bad.length ? ` (${bad.map(check => check.name).join(", ")})` : ""}`,
		);
	}
	if (failed) return EXIT.failed;
	return unavailable ? EXIT.unavailable : EXIT.ok;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
