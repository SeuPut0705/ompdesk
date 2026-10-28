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
//                   Inside a fast model, a matrix run with `"tier": "deep"` is skipped by `--tier fast` (and runs with
//                   `--tier deep` or `--only`), so a model keeps its quick runs in the inner loop.
//   --stamp         after a model passed everything, write the current HEAD into its `syncCommit`. The sha only has
//                   to hold the covered code: the model files may be uncommitted or not exist at it. Refused while
//                   the covered code (the covered functions and ranges, not whole files) has uncommitted changes or a
//                   cover points at nothing. A syncCommit that is not in the repository (a squash merge, a shallow clone)
//                   does not block it: stamping is the repair
//   --allow-dirty   with --stamp: stamp those uncommitted changes too (HEAD plus a `syncDiff` digest of the covered
//                   code), for when the task forbids committing. The model is in sync while the covered code equals
//                   what was stamped, committed or not
//   --strict-drift  covered code changed since the sync commit, or no sync commit yet, fail the run
//
// Exit: 0 all passed, 1 a check ran and failed (or strict drift), 2 usage or bad manifest, 3 UNAVAILABLE (a tool
// could not be prepared: not checked) when nothing failed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main as leanMain } from "./lean-check";
import { checkTags, extractTags } from "./lib/code-tags";
import { checkDrift, git, planStamp } from "./lib/drift";
import { isRecord, readJson } from "./lib/json";
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
	/** `badCommit`: the drift check found the old syncCommit missing from the repository, which a stamp repairs. */
	checks: { name: string; verdict: Verdict; note?: string; badCommit?: boolean }[];
}

/** Matrix runs of a fast tier. `file` is what TLC should read (null: no run is left), `cleanup` removes a temporary file. */
export interface MatrixPlan {
	file: string | null;
	/** Names of the deep runs left out. */
	skipped: string[];
	cleanup: () => void;
}

/**
 * The matrix file for a tier: `--tier fast` drops the runs marked `"tier": "deep"` (written to a temporary file TLC
 * reads instead), `--tier deep` keeps the file as it is. A run's `tier` is `fast` or `deep`.
 */
export function matrixForTier(file: string, tier: "fast" | "deep"): MatrixPlan {
	const keep: MatrixPlan = { file, skipped: [], cleanup: () => {} };
	const parsed = readJson(file);
	if (!isRecord(parsed) || !Array.isArray(parsed.runs)) return keep; // tlc.ts names what is wrong with it
	const runs: unknown[] = parsed.runs;
	runs.forEach((run, index) => {
		if (isRecord(run) && run.tier !== undefined && run.tier !== "fast" && run.tier !== "deep")
			throw new Error(`matrix: runs[${index}].tier must be "fast" or "deep"`);
	});
	const isDeep = (run: unknown): boolean => isRecord(run) && run.tier === "deep";
	if (tier === "deep" || !runs.some(isDeep)) return keep;
	const skipped = runs.filter(isDeep).map(run => String((run as { name?: unknown }).name));
	const left = runs.filter(run => !isDeep(run));
	if (left.length === 0) return { file: null, skipped, cleanup: () => {} };
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fv-matrix-"));
	const filtered = path.join(folder, "matrix.json");
	fs.writeFileSync(filtered, JSON.stringify({ ...parsed, runs: left }));
	return { file: filtered, skipped, cleanup: () => fs.rmSync(folder, { recursive: true, force: true }) };
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
	const add = (name: string, verdict: Verdict, note?: string, badCommit?: boolean): void => {
		result.checks.push({ name, verdict, ...(note ? { note } : {}), ...(badCommit ? { badCommit } : {}) });
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
		if (model.matrix) {
			let plan: MatrixPlan;
			try {
				plan = matrixForTier(path.join(dir, model.matrix), args.only ? "deep" : args.tier);
			} catch (error) {
				add("TLC matrix", "fail", error instanceof Error ? error.message : String(error));
				return result;
			}
			const left = plan.skipped.length
				? `${plan.skipped.length} deep run${plan.skipped.length === 1 ? "" : "s"} skipped (--tier deep runs ${plan.skipped.length === 1 ? "it" : "them"})`
				: undefined;
			if (plan.file === null) add("TLC matrix", "skipped", left);
			else {
				try {
					add("TLC matrix", verdictOf(await tlcMain([spec, "--matrix", plan.file])), left);
				} finally {
					plan.cleanup();
				}
			}
		} else {
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
	else if (drift.status === "bad-commit" && args.stamp)
		add("drift", args.strictDrift ? "fail" : "drift", drift.message, true);
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
		const driftCheck = result.checks.find(check => check.name === "drift");
		const clean = result.checks.every(
			check =>
				check.verdict === "pass" ||
				check.verdict === "skipped" ||
				check.verdict === "drift" ||
				check.badCommit === true,
		);
		if (!clean) {
			console.log(`\nstamp: ${result.id} not stamped (a check did not pass)`);
			continue;
		}
		const plan = await planStamp(codeRoot, model.covers, head.out);
		if (plan.error) console.log(`\nstamp: ${result.id} not stamped: ${plan.error}`);
		else if (plan.dirty && !allowDirty)
			console.log(
				`\nstamp: ${result.id} not stamped: the covered code has uncommitted changes, so HEAD does not describe it. Commit them (when you may), or rerun with --stamp --allow-dirty to stamp HEAD plus those changes (references/persist.md, "The sync commit").`,
			);
		else {
			const entry = raw.models.find(candidate => candidate.id === result.id);
			if (!entry) continue;
			if (driftCheck?.badCommit) {
				console.log(
					`\nstamp: NOTE ${result.id}: its old syncCommit is not in this repository (squash merge, rewritten history or a shallow clone), so nothing could be compared. Stamping says you checked the model against the covered code as it is now: do that first (references/persist.md, steps 3 and 4).`,
				);
			} else if (driftCheck?.verdict === "drift") {
				console.log(
					`\nstamp: NOTE ${result.id}: covered code changed since its old syncCommit. Stamping says you checked the model against it: do that first (references/persist.md, steps 3 and 4).`,
				);
			}
			entry.syncCommit = head.out;
			if (plan.dirty) {
				entry.syncDiff = plan.digest;
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

/**
 * One summary line per model. Only a pass counts as ok: drift and skipped checks are named apart. The label is FAIL
 * when a check failed, NOT CHECKED when one could not run, DRIFT when covered code changed, else PASS.
 */
export function summarize(results: ModelResult[]): string[] {
	return results.map(result => {
		const count = (verdict: Verdict): number => result.checks.filter(check => check.verdict === verdict).length;
		const bad = result.checks.filter(check => check.verdict === "fail" || check.verdict === "unavailable");
		const label = count("fail") ? "FAIL" : count("unavailable") ? "NOT CHECKED" : count("drift") ? "DRIFT" : "PASS";
		const parts = [`${count("pass")} of ${result.checks.length} ok`];
		if (count("drift")) parts.push(`${count("drift")} drift`);
		if (count("skipped")) parts.push(`${count("skipped")} skipped`);
		return `${label}  ${result.id}: ${parts.join(", ")}${bad.length ? ` (${bad.map(check => check.name).join(", ")})` : ""}`;
	});
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
	for (const line of summarize(results)) console.log(line);
	if (failed) return EXIT.failed;
	return unavailable ? EXIT.unavailable : EXIT.ok;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
