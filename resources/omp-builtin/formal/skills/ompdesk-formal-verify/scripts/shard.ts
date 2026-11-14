#!/usr/bin/env bun
// Spreads a verify-all run over independent CI jobs, one TLC check each, and lets verify-all print the one report
// from their verdicts. For TLA+ models only; a check never depends on another's result, so they can run side by side.
//
//   bun shard.ts plan <formal dir> [--tier fast|deep] [--only id] [--skip-mutations] [--github-output] [--limit N]
//       Lists the checks of the models verify-all would run: every matrix run, and for a model with mutations the
//       baseline (the unmutated model), one baseline per config a mutation brings, and every mutation. Prints the
//       plan as JSON, or with --github-output (a GitHub Actions step) writes the `matrix` of jobs and their
//       `jobs` count to $GITHUB_OUTPUT. More checks than a matrix may hold (256) are dealt over `--limit` jobs.
//   bun shard.ts run <formal dir> --units "<model>/<unit> ..." --out <folder> [--cache <folder>] [same flags as plan]
//       Runs those checks (the flags must be the plan's, they decide which checks exist) and writes one verdict file
//       per check under <folder>/<model>/. A check that fails is a verdict, not an error: the exit code is 0 unless
//       the script itself broke. With --cache, a check whose input digest is in the folder is not run again.
//   then: bun verify-all.ts <formal dir> [same flags] --verdicts <folder> [--stamp]
//   --inspect-unit <model>/<row> selects one existing matrix row with --only and --skip-mutations, never a stamp.
//       Its bounded verdict and summary are observations of that row, not a verification pass for the model.
//
// A check's digest covers the normalized text of every module in the spec's folder (comments blanked, so `@code` tags
// may move), the config TLC reads, its options (worker count, deadlock, extra arguments), the pinned jar digests and
// the java that runs them, never the time limit. Only a verdict that settles the matter is cached: a run that ended as
// the matrix expected, and a mutation check that passed or failed. A timeout, an error, an unsound run and an
// unavailable tool are run again.
//
// Exit: 0 done, 2 usage or bad input, 3 UNAVAILABLE (plan: TLC could not be prepared).
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { overrideConstants } from "./lib/cfg";
import { checkerRoot, makeChecker, tlcCheckInputs } from "./lib/checkers";
import { isRecord, readJson } from "./lib/json";
import { type ModelEntry, parseManifest } from "./lib/manifest";
import { judge, type MatrixRun, parseMatrix } from "./lib/matrix";
import {
	type Checker,
	type CheckerSpec,
	type MutationPlan,
	type MutationSpec,
	type MutationUnit,
	parseMutations,
	planMutations,
	runMutationUnit,
} from "./lib/mutate-core";
import { EXIT, Unavailable, UsageError } from "./lib/proc";
import { removeTree } from "./lib/scratch";
import {
	type CheckVerdict,
	cacheGet,
	cachePut,
	checkDigest,
	MATRIX_LIMIT,
	modulesDigest,
	type PlannedUnit,
	packUnits,
	parseUnitRef,
	type RowVerdict,
	readVerdict,
	rowUnitId,
	safetyOnly,
	storedRun,
	type ToolsInfo,
	unitRef,
	VERDICT_VERSION,
	writeVerdict,
} from "./lib/shard";
import { prepareTla, probeJava, type TlaEnv } from "./lib/tla-env";
import { runTlc } from "./lib/tlc-run";
import { loadToolchain } from "./lib/toolchain";
import { DEFAULT_TIMEOUT_SEC, rowRunOptions } from "./tlc";
import {
	matrixForTier,
	matrixTier,
	parseArgs as parseVerifyArgs,
	selectModels,
	type Args as VerifyArgs,
} from "./verify-all";

const USAGE = [
	"usage: bun shard.ts plan <formal dir> [--tier fast|deep] [--only id] [--skip-mutations] [--inspect-unit model/row] [--github-output] [--limit N]",
	'       bun shard.ts run <formal dir> --units "<model>/<unit> ..." --out <folder> [--cache <folder>] [plan flags]',
	"       bun shard.ts costs <verdicts folder> --into <formal dir>/shard-costs.json",
].join("\n");

type TlcChecker = Extract<CheckerSpec, { kind: "tlc" }>;

/** A mutation checker's time limit when the mutations file names none (the checker's own default). */
const CHECK_TIMEOUT_SEC = 180;

interface RowUnit {
	unit: string;
	run: MatrixRun;
}

interface MutationPart {
	root: string;
	spec: MutationSpec;
	checker: TlcChecker;
	plan: MutationPlan;
}

/** What one model contributes: the runs of its matrix (or its configs) and its mutation checks. */
export interface ModelUnits {
	model: ModelEntry;
	/** The spec's folder, and the spec file. */
	dir: string;
	spec: string;
	rows: RowUnit[];
	mutation?: MutationPart;
}

export function modelUnits(model: ModelEntry, formalDir: string, args: VerifyArgs): ModelUnits {
	if (model.kind !== "tla" || !model.spec)
		throw new Error(
			`${model.id}: only TLA+ models are spread over jobs; run a Lean model with verify-all.ts --only ${model.id}`,
		);
	const folder = path.resolve(formalDir, model.dir);
	const spec = path.join(folder, model.spec);
	const dir = path.dirname(spec);
	let rows: RowUnit[] = [];
	if (model.matrix) {
		const plan = matrixForTier(path.join(folder, model.matrix), matrixTier(args));
		try {
			if (plan.file !== null)
				rows = parseMatrix(readJson(plan.file)).map((run, index) => ({ unit: rowUnitId(index, run.name), run }));
		} finally {
			plan.cleanup();
		}
	} else {
		rows = (model.configs ?? [`${path.basename(spec, ".tla")}.cfg`]).map((config, index) => ({
			unit: rowUnitId(index, config),
			run: { name: path.basename(config), expect: "pass", config: path.join(folder, config) },
		}));
	}
	const units: ModelUnits = { model, dir, spec, rows };
	if (model.mutations && !args.skipMutations) {
		const file = path.join(folder, model.mutations);
		const mutationSpec = parseMutations(readJson(file));
		if (mutationSpec.checker.kind !== "tlc")
			throw new Error(`${model.id}: the ${mutationSpec.checker.kind} checker of its mutations is not a TLC check`);
		const root = checkerRoot(mutationSpec.checker, dir, path.dirname(file));
		units.mutation = { root, spec: mutationSpec, checker: mutationSpec.checker, plan: planMutations(mutationSpec) };
	}
	return units;
}

/** What the tools are, for a digest, and what a verdict says about them. */
async function toolsIdentity(tla: TlaEnv): Promise<{ id: string; info: ToolsInfo }> {
	const pins = loadToolchain().tla;
	const java = await probeJava(tla.java);
	return {
		id: JSON.stringify([
			pins.tla2tools.sha256,
			pins.communityModules.sha256,
			tla.javaMajor,
			java.text,
			process.platform,
			process.arch,
		]),
		info: { tlaVersion: tla.tlaVersion, javaMajor: tla.javaMajor, javaSource: tla.javaSource },
	};
}

interface RowPlan {
	key: string;
	workers: string;
	timeoutSec: number;
}

/**
 * How a matrix run is checked here. A run that must pass and has nothing but safety properties uses every core (a
 * pass is the same whatever the thread count); every other run keeps one worker, so a counterexample is the same
 * shortest one on every run. `workers` in the matrix always wins.
 */
function rowPlan(units: ModelUnits, row: RowUnit, tools: string): RowPlan {
	const configPath = path.resolve(units.dir, row.run.config ?? `${path.basename(units.spec, ".tla")}.cfg`);
	const configText = fs.readFileSync(configPath, "utf8");
	const workers =
		row.run.workers ??
		(row.run.expect === "pass" && !row.run.args?.length && safetyOnly(configText, fs.readFileSync(units.spec, "utf8"))
			? "auto"
			: "1");
	const constants = row.run.constants;
	return {
		key: checkDigest({
			kind: "row",
			modules: modulesDigest(units.dir),
			config: constants && Object.keys(constants).length > 0 ? overrideConstants(configText, constants) : configText,
			options: { workers, deadlockOff: row.run.deadlock === false, extra: row.run.args ?? [] },
			tools,
		}),
		workers,
		timeoutSec: row.run.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
	};
}

/** A check of a mutation run uses the checker's declared workers when its properties are safety ones, else one. */
function checkWorkers(part: MutationPart, unit: MutationUnit, spec: string): string {
	const declared = part.checker.workers ?? "1";
	if (declared === "1") return "1";
	const mutation = unit.kind === "baseline" ? undefined : unit.mutation;
	const config = mutation?.config ?? part.checker.config ?? `${path.basename(spec, ".tla")}.cfg`;
	const configText = fs.readFileSync(path.join(path.dirname(spec), config), "utf8");
	return safetyOnly(configText, fs.readFileSync(spec, "utf8"), mutation?.isolate ? mutation.breaks : undefined)
		? declared
		: "1";
}

function keyOfCheck(checker: TlcChecker, model: string, mutation: Parameters<Checker>[2], tools: string): string {
	const inputs = tlcCheckInputs(checker, model, mutation);
	if ("error" in inputs) return createHash("sha256").update(inputs.error).digest("hex");
	return checkDigest({
		kind: "check",
		modules: modulesDigest(path.dirname(model)),
		config: inputs.configText,
		options: { workers: inputs.workers ?? "1", deadlockOff: inputs.deadlockOff },
		tools,
	});
}

interface Scratch {
	dir: string;
	done(): void;
}

function scratch(): Scratch {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-shard-"));
	return { dir, done: () => void removeTree(dir) };
}

/** The unit's digest and workers, found by applying its mutation to a scratch copy and asking what TLC would read. */
async function checkPlan(
	units: ModelUnits,
	unit: MutationUnit,
	tools: string,
): Promise<{ key: string; workers: string }> {
	const part = units.mutation;
	if (!part) throw new Error(`${units.model.id} has no mutation checks`);
	const workers = checkWorkers(part, unit, units.spec);
	const checker = { ...part.checker, workers };
	let key = "";
	const work = scratch();
	try {
		const result = await runMutationUnit(
			{
				root: part.root,
				model: units.spec,
				work: work.dir,
				check: async (_dir, model, mutation) => {
					key = keyOfCheck(checker, model, mutation, tools);
					return { status: "pass", violated: [], detail: "" };
				},
			},
			unit,
		);
		if (result.invalid !== undefined) key = createHash("sha256").update(result.invalid).digest("hex");
	} finally {
		work.done();
	}
	return { key, workers };
}

/** The file `shard.ts costs` writes beside the manifest: seconds a unit took, by `<model>/<unit>`. */
export const COSTS_FILE = "shard-costs.json";

/** The recorded costs of a formal folder (none when no run recorded any). */
export function loadCosts(formalDir: string): Map<string, number> {
	const file = path.join(formalDir, COSTS_FILE);
	if (!fs.existsSync(file)) return new Map();
	const parsed = readJson(file);
	if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.seconds))
		throw new UsageError(`${file}: expected {"version": 1, "seconds": {"<model>/<unit>": seconds}}`);
	const costs = new Map<string, number>();
	for (const [ref, seconds] of Object.entries(parsed.seconds)) {
		if (typeof seconds !== "number" || !(seconds > 0))
			throw new UsageError(`${file}: ${ref} needs a positive number`);
		costs.set(ref, seconds);
	}
	return costs;
}

/**
 * The units of a plan with their expected times: what a run recorded, else a guess by kind (a run that must pass and
 * a baseline explore the whole state space; a mutation usually fails early, unless it is declared equivalent).
 */
export async function planUnits(
	all: ModelUnits[],
	tools: string,
	costs: ReadonlyMap<string, number> = new Map(),
): Promise<PlannedUnit[]> {
	const units: PlannedUnit[] = [];
	for (const model of all) {
		const id = model.model.id;
		for (const row of model.rows) {
			const plan = rowPlan(model, row, tools);
			units.push({
				model: id,
				unit: row.unit,
				kind: "row",
				label: `${id}: ${row.run.name}`,
				timeoutSec: plan.timeoutSec,
				estimateSec: costs.get(unitRef(id, row.unit)) ?? (row.run.expect === "pass" ? 60 : 15),
				workers: plan.workers,
				key: plan.key,
			});
		}
		const part = model.mutation;
		if (!part) continue;
		for (const check of part.plan.units) {
			const plan = await checkPlan(model, check, tools);
			const title =
				check.kind === "baseline"
					? "baseline"
					: check.kind === "config-baseline"
						? `baseline under ${check.mutation.config}`
						: `mutation ${check.mutation.name}`;
			const whole = check.kind !== "mutation" || check.mutation.equivalent !== undefined;
			units.push({
				model: id,
				unit: check.id,
				kind: check.kind,
				label: `${id}: ${title}`,
				timeoutSec: part.checker.timeoutSec ?? CHECK_TIMEOUT_SEC,
				estimateSec: costs.get(unitRef(id, check.id)) ?? (whole ? 120 : 30),
				workers: plan.workers,
				key: plan.key,
			});
		}
	}
	return units;
}

interface Inspection {
	ref: string;
	model: string;
	unit: string;
}

function inspectionKey(key: string, inspection: Inspection): string {
	return createHash("sha256")
		.update("inspect-unit-v1\0")
		.update(inspection.ref)
		.update(key)
		.update(fs.readFileSync(import.meta.filename))
		.digest("hex");
}

interface Flags {
	verify: VerifyArgs;
	githubOutput: boolean;
	limit: number;
	units: string[];
	out?: string;
	cache?: string;
	inspection?: Inspection;
}

function parseFlags(argv: string[]): Flags {
	const own: Omit<Flags, "verify"> = { githubOutput: false, limit: MATRIX_LIMIT, units: [] };
	const rest: string[] = [];
	let unitLists = 0;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		const value = (): string => {
			const next = argv[++i];
			if (next === undefined) throw new UsageError(`${arg} needs a value\n${USAGE}`);
			return next;
		};
		if (arg === "--github-output") own.githubOutput = true;
		else if (arg === "--limit") {
			own.limit = Number(value());
			if (!Number.isInteger(own.limit) || own.limit < 1)
				throw new UsageError(`--limit takes a positive integer\n${USAGE}`);
		} else if (arg === "--units") {
			unitLists++;
			own.units = value().split(/\s+/).filter(Boolean);
		} else if (arg === "--inspect-unit") {
			if (own.inspection) throw new UsageError("--inspect-unit must occur once");
			const ref = value();
			try {
				if (/[\s*?[\]{}]/.test(ref)) throw new Error("lists and patterns are not units");
				own.inspection = { ref, ...parseUnitRef(ref) };
			} catch {
				throw new UsageError("--inspect-unit needs one exact <model>/<row> reference");
			}
		} else if (arg === "--out") own.out = value();
		else if (arg === "--cache") own.cache = value();
		else rest.push(arg);
	}
	const verify = parseVerifyArgs(rest);
	if (
		own.inspection &&
		(verify.only !== own.inspection.model ||
			!verify.skipMutations ||
			verify.stamp ||
			verify.allowDirty ||
			verify.strictDrift ||
			verify.verdicts ||
			unitLists > 1)
	)
		throw new UsageError(
			"--inspect-unit requires matching --only, --skip-mutations and no stamp or verification options",
		);
	return { ...own, verify };
}

function modelsOf(flags: Flags): ModelUnits[] {
	try {
		const formalDir = path.resolve(flags.verify.dir);
		const manifest = parseManifest(readJson(path.join(formalDir, "manifest.json")));
		const models = selectModels(manifest, flags.verify);
		if (models.length === 0)
			throw new Error(
				flags.verify.only
					? `no model ${flags.verify.only} in the manifest (${manifest.models.map(model => model.id).join(", ")})`
					: `no ${flags.verify.tier}-tier model in the manifest`,
			);
		const units = models.map(model =>
			modelUnits(model, formalDir, flags.inspection ? { ...flags.verify, tierGiven: true } : flags.verify),
		);
		if (!flags.inspection) return units;
		const selected = units.find(item => item.model.id === flags.inspection?.model);
		const rows = selected?.rows.filter(row => row.unit === flags.inspection?.unit) ?? [];
		if (units.length !== 1 || !selected || rows.length !== 1)
			throw new UsageError(`${flags.inspection.ref}: not exactly one matrix row in the selected tier`);
		return [{ ...selected, rows, mutation: undefined }];
	} catch (error) {
		throw error instanceof UsageError
			? error
			: new UsageError(error instanceof Error ? error.message : String(error));
	}
}

async function prepare(): Promise<{ tla: TlaEnv; tools: { id: string; info: ToolsInfo } } | undefined> {
	try {
		const tla = await prepareTla();
		return { tla, tools: await toolsIdentity(tla) };
	} catch (error) {
		if (error instanceof Unavailable) {
			console.log(`UNAVAILABLE  TLC could not be prepared: ${error.message}`);
			return undefined;
		}
		throw error;
	}
}

async function planCommand(flags: Flags): Promise<number> {
	const all = modelsOf(flags);
	const prepared = await prepare();
	if (!prepared) return EXIT.unavailable;
	const units = await planUnits(all, prepared.tools.id, loadCosts(path.resolve(flags.verify.dir)));
	if (flags.inspection) for (const unit of units) unit.key = inspectionKey(unit.key, flags.inspection);
	const jobs = packUnits(units, { limit: flags.limit });
	const matrix = {
		include: jobs.map(job => ({
			id: job.id,
			label: job.label,
			units: job.units.join(" "),
			key: job.key,
			timeout: job.timeoutMin,
		})),
	};
	if (!flags.githubOutput) {
		console.log(JSON.stringify({ units, jobs, matrix }, null, 2));
		return EXIT.ok;
	}
	const output = process.env.GITHUB_OUTPUT;
	if (!output) throw new UsageError("--github-output needs $GITHUB_OUTPUT (run it as a GitHub Actions step)");
	fs.appendFileSync(output, `matrix=${JSON.stringify(matrix)}\njobs=${jobs.length}\n`);
	for (const units of all) {
		const own = jobs.flatMap(job => job.units).filter(ref => ref.startsWith(`${units.model.id}/`)).length;
		console.log(
			`${units.model.id}: ${own} checks (${units.rows.length} matrix runs, ${units.mutation?.plan.units.length ?? 0} mutation checks)`,
		);
	}
	console.log(`${jobs.length} jobs${jobs.length < units.length ? ` for ${units.length} checks` : ""}`);
	return EXIT.ok;
}

interface RunContext {
	tla: TlaEnv;
	tools: { id: string; info: ToolsInfo };
	cache?: string;
	inspection?: Inspection;
}

async function runRow(units: ModelUnits, row: RowUnit, context: RunContext): Promise<RowVerdict> {
	const plan = rowPlan(units, row, context.tools.id);
	const base = {
		version: VERDICT_VERSION,
		kind: "row",
		model: units.model.id,
		unit: row.unit,
		name: row.run.name,
		key: context.inspection ? inspectionKey(plan.key, context.inspection) : plan.key,
		workers: plan.workers,
		tools: context.tools.info,
	} as const;
	const hit = context.cache ? cacheGet(context.cache, plan.key) : undefined;
	if (hit?.kind === "row") return { ...hit, ...base, cached: true };
	const run: MatrixRun = { ...row.run, workers: plan.workers };
	const started = Date.now();
	const tlcRun = await runTlc({
		tla: context.tla,
		...rowRunOptions(run, units.spec, {
			noDeadlock: false,
			coverage: false,
			extra: [],
			workers: undefined,
			timeoutSec: undefined,
		}),
		onProgress: line => {
			// TLC prints one last Progress line when a short run ends: noise unless the run took a while.
			if (Date.now() - started >= 10_000) console.log(`  ${row.run.name}: ${line}`);
		},
	});
	const verdict: RowVerdict = { ...base, cached: false, run: storedRun(tlcRun, units.dir) };
	if (context.cache && !tlcRun.spawnError && judge(run, tlcRun.result).ok) cachePut(context.cache, plan.key, verdict);
	return verdict;
}

async function runCheck(units: ModelUnits, unit: MutationUnit, context: RunContext): Promise<CheckVerdict> {
	const part = units.mutation;
	if (!part) throw new Error(`${units.model.id} has no mutation checks`);
	const workers = checkWorkers(part, unit, units.spec);
	const checker = { ...part.checker, workers };
	const inner = makeChecker(checker);
	let seen = { key: "", cached: false };
	const check: Checker = async (dir, model, mutation) => {
		const key = keyOfCheck(checker, model, mutation, context.tools.id);
		seen = { key, cached: false };
		const hit = context.cache ? cacheGet(context.cache, key) : undefined;
		if (hit && hit.kind !== "row" && hit.result.outcome) {
			seen.cached = true;
			return hit.result.outcome;
		}
		return inner(dir, model, mutation);
	};
	const work = scratch();
	const started = Date.now();
	try {
		const result = await runMutationUnit({ root: part.root, model: units.spec, check, work: work.dir }, unit);
		const verdict: CheckVerdict = {
			version: VERDICT_VERSION,
			kind: unit.kind,
			model: units.model.id,
			unit: unit.id,
			name: unit.kind === "baseline" ? "baseline" : unit.mutation.name,
			key: seen.key,
			cached: seen.cached,
			workers,
			tools: context.tools.info,
			durationMs: Date.now() - started,
			result,
		};
		const status = result.outcome?.status;
		if (context.cache && seen.key && !seen.cached && (status === "pass" || status === "fail"))
			cachePut(context.cache, seen.key, verdict);
		return verdict;
	} finally {
		work.done();
	}
}

/** A verdict for a unit whose tools could not be prepared: the report says NOT CHECKED, never a pass. */
function unavailableVerdict(
	units: ModelUnits,
	unit: string,
	tools: ToolsInfo,
	detail: string,
): RowVerdict | CheckVerdict {
	const row = units.rows.find(candidate => candidate.unit === unit);
	const base = {
		version: VERDICT_VERSION,
		model: units.model.id,
		unit,
		key: "",
		cached: false,
		workers: "1",
		tools,
	} as const;
	if (row) {
		return {
			...base,
			kind: "row",
			name: row.run.name,
			run: {
				code: null,
				result: { outcome: "error", stats: {}, trace: [], errors: [], warnings: [] },
				text: "",
				configUsed: "",
				durationMs: 0,
				spawnError: detail,
			},
		};
	}
	const check = units.mutation?.plan.units.find(candidate => candidate.id === unit);
	if (!check) throw new Error(`${units.model.id} has no unit ${unit}`);
	return {
		...base,
		kind: check.kind,
		name: check.kind === "baseline" ? "baseline" : check.mutation.name,
		durationMs: 0,
		result: { outcome: { status: "unavailable", violated: [], detail } },
	};
}

const MAX_INSPECTION_BYTES = 1024 * 1024;

function recordInspection(
	out: string,
	inspection: Inspection,
	row: RowUnit,
	verdict: RowVerdict,
	available: boolean,
): number {
	const judgment = judge(row.run, verdict.run.result);
	let status =
		!available ||
		verdict.run.code === null ||
		verdict.run.spawnError ||
		verdict.run.result.outcome === "error" ||
		verdict.run.result.outcome === "timeout"
			? "INCONCLUSIVE"
			: judgment.ok
				? "OBSERVED"
				: "UNEXPECTED";
	const raw = JSON.stringify(verdict);
	const bytes = Buffer.byteLength(raw);
	const complete = bytes <= MAX_INSPECTION_BYTES;
	if (!complete) status = "INCONCLUSIVE";
	const summary = {
		scope: "single-matrix-row-inspection",
		unit: inspection.ref,
		key: verdict.key,
		status,
		expected: { outcome: row.run.expect, property: row.run.property ?? null },
		actual: {
			code: verdict.run.code,
			outcome: verdict.run.result.outcome,
			property: verdict.run.result.property ?? null,
			stats: verdict.run.result.stats,
			spawnError: verdict.run.spawnError ?? null,
		},
		judgment,
		evidence: { complete, bytes, limit: MAX_INSPECTION_BYTES },
		modelVerified: false,
	};
	const summaryText = JSON.stringify(summary);
	const summaryFits = Buffer.byteLength(summaryText) <= MAX_INSPECTION_BYTES;
	if (!summaryFits) status = "INCONCLUSIVE";
	const omitted = JSON.stringify({
		scope: summary.scope,
		status: "INCONCLUSIVE",
		key: verdict.key,
		code: verdict.run.code,
		outcome: verdict.run.result.outcome,
		reason: "inspection evidence exceeds its artifact limit",
		modelVerified: false,
	});
	const folder = path.join(out, "inspection");
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(path.join(folder, "verdict.json"), complete ? raw : omitted);
	fs.writeFileSync(path.join(folder, "summary.json"), summaryFits ? summaryText : omitted);
	console.log(
		`Single-unit inspection ${status}: ${inspection.ref}; TLC rc=${verdict.run.code}; ${judgment.reason}. Not a model verification pass or stamp.`,
	);
	return !available ? EXIT.unavailable : status === "OBSERVED" ? EXIT.ok : EXIT.failed;
}

async function runCommand(flags: Flags): Promise<number> {
	if (flags.units.length === 0 || !flags.out) throw new UsageError(`run needs --units and --out\n${USAGE}`);
	const out = path.resolve(flags.out);
	const selected = modelsOf(flags);
	if (flags.inspection && (flags.units.length !== 1 || flags.units[0] !== flags.inspection.ref))
		throw new UsageError("--inspect-unit run requires exactly one matching --units reference");
	const all = new Map(selected.map(units => [units.model.id, units]));
	const prepared = await prepare();
	for (const ref of flags.units) {
		const { model, unit } = parseUnitRef(ref);
		const units = all.get(model);
		if (!units) throw new UsageError(`${ref}: no model ${model} in this run (${[...all.keys()].join(", ")})`);
		const started = Date.now();
		let verdict: RowVerdict | CheckVerdict;
		if (!prepared) {
			const unavailable = "TLC could not be prepared on this runner";
			verdict = unavailableVerdict(units, unit, { tlaVersion: "", javaMajor: 0, javaSource: "" }, unavailable);
		} else {
			const context: RunContext = {
				tla: prepared.tla,
				tools: prepared.tools,
				...(flags.cache && !flags.inspection ? { cache: path.resolve(flags.cache) } : {}),
				...(flags.inspection ? { inspection: flags.inspection } : {}),
			};
			const row = units.rows.find(candidate => candidate.unit === unit);
			const check = units.mutation?.plan.units.find(candidate => candidate.id === unit);
			if (row) verdict = await runRow(units, row, context);
			else if (check) verdict = await runCheck(units, check, context);
			else throw new UsageError(`${ref}: ${model} has no unit ${unit}`);
		}
		if (flags.inspection) {
			const row = units.rows[0];
			if (!row || verdict.kind !== "row") throw new UsageError("inspection did not resolve a matrix row");
			return recordInspection(out, flags.inspection, row, verdict, prepared !== undefined);
		}
		writeVerdict(out, verdict);
		const outcome =
			verdict.kind === "row" ? verdict.run.result.outcome : (verdict.result.outcome?.status ?? "invalid");
		console.log(
			`${unitRef(model, unit)}: ${outcome}${verdict.cached ? " (cached)" : ""} in ${((Date.now() - started) / 1000).toFixed(1)} s`,
		);
	}
	return EXIT.ok;
}

/**
 * `costs <verdicts folder> --into <formal dir>/shard-costs.json`: records how long each unit of a run took (its TLC
 * time, from the verdict files that `gh run download <id> -p "formal-verdict-*" -D verdicts` brings), so the next
 * plan puts the short units together and gives the long ones a runner each.
 */
function costsCommand(argv: string[]): number {
	const [folder, flag, into] = argv;
	if (!folder || flag !== "--into" || !into) throw new UsageError(USAGE);
	const costs = loadCosts(path.dirname(path.resolve(into)));
	for (const model of fs.readdirSync(folder)) {
		const dir = path.join(folder, model);
		if (!fs.statSync(dir).isDirectory()) continue;
		for (const file of fs.readdirSync(dir).filter(name => name.endsWith(".json"))) {
			const verdict = readVerdict(folder, model, file.slice(0, -".json".length));
			if (!verdict) continue;
			const ms = verdict.kind === "row" ? verdict.run.durationMs : verdict.durationMs;
			costs.set(unitRef(model, verdict.unit), Math.max(1, Math.round(ms / 1000)));
		}
	}
	const seconds = Object.fromEntries([...costs].sort(([a], [b]) => a.localeCompare(b)));
	fs.writeFileSync(path.resolve(into), `${JSON.stringify({ version: 1, seconds }, null, "\t")}\n`);
	console.log(`${costs.size} units' costs written to ${into}`);
	return EXIT.ok;
}

export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	try {
		if (command === "costs") return costsCommand(rest);
		if (command !== "plan" && command !== "run") throw new UsageError(USAGE);
		const flags = parseFlags(rest);
		return command === "plan" ? await planCommand(flags) : await runCommand(flags);
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(error.message);
			return EXIT.usage;
		}
		throw error;
	}
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
