// What a run of a model needs to be spread over CI jobs and put together again: stable unit ids, the digest that says
// two checks read the same input, the verdict file a unit job writes, and the cache of verdicts. `shard.ts` (the
// script) plans and runs units; `verify-all.ts --verdicts` reads them back and prints the one report.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseCfg } from "./cfg";
import { isRecord } from "./json";
import { maskTlaComments, type UnitResult, type UnitResults } from "./mutate-core";
import type { TlcResult } from "./tlc-parse";
import type { TlcRun } from "./tlc-run";

/** Bumped when a verdict file or a digest changes meaning: old files and cache entries are then never read. */
export const VERDICT_VERSION = 1;

export type UnitKind = "row" | "baseline" | "config-baseline" | "mutation";

/** `a` cut to file-name-safe characters, at most `max` of them. */
export function slug(text: string, max = 48): string {
	return text.replace(/[^\w.-]+/g, "_").slice(0, max);
}

/** The id of run `index` of a model's matrix (or of its `index`th config when it has no matrix). */
export function rowUnitId(index: number, name: string): string {
	return `r${index}-${slug(name)}`;
}

/** `turn-resume/m3-fire-hold`: a model and one of its units. */
export function unitRef(model: string, unit: string): string {
	return `${model}/${unit}`;
}

export function parseUnitRef(ref: string): { model: string; unit: string } {
	const at = ref.indexOf("/");
	if (at <= 0 || at === ref.length - 1) throw new Error(`a unit is named <model>/<unit>, got ${ref}`);
	return { model: ref.slice(0, at), unit: ref.slice(at + 1) };
}

/**
 * A TLA+ module's text as TLC reads it: comments (`\* ...`, `(* ... *)`) are blanked, the blank is dropped from the
 * end of every line and blank lines go. What is left changes only when the model's meaning can: an `@code` tag or any
 * other comment may be rewritten, moved or lengthened without changing it. Leading blanks stay (a conjunction list
 * is read by its columns), and so does the length of a comment in front of code on one line, which moves it.
 */
export function normalizeTla(source: string): string {
	return maskTlaComments(source.replace(/\r\n/g, "\n"))
		.split("\n")
		.map(line => line.trimEnd())
		.filter(line => line !== "")
		.join("\n");
}

/** Every module TLC could load from the spec's folder, normalized, by file name. */
export function modulesDigest(dir: string): string {
	const hash = createHash("sha256");
	for (const name of fs.readdirSync(dir).filter(file => file.endsWith(".tla"))) {
		hash.update(`${name}\0${normalizeTla(fs.readFileSync(path.join(dir, name), "utf8"))}\0`);
	}
	return hash.digest("hex");
}

/** The digest of everything a TLC verdict is a function of: the modules, the config TLC reads, its options and its tools. */
export function checkDigest(parts: {
	kind: "row" | "check";
	modules: string;
	/** The config text TLC reads (after a constants override or a property isolation). */
	config: string;
	/** Everything else that goes to TLC (workers, deadlock, extra arguments); never the time limit. */
	options: unknown;
	/** What the tools are: pinned jar digests and the java that runs them. */
	tools: string;
}): string {
	return createHash("sha256")
		.update(JSON.stringify([VERDICT_VERSION, parts.kind, parts.modules, parts.config, parts.options, parts.tools]))
		.digest("hex");
}

/** Joins unit digests into one: the key of a CI job that runs several units. */
export function jobKey(keys: string[]): string {
	return keys.length === 1 ? (keys[0] as string) : createHash("sha256").update(keys.join("\n")).digest("hex");
}

const NOT_SAFETY = /<>|~>|\bWF_|\bSF_/;

/** The text of `name == ...` in a spec: from its header to the next line that starts in column 0. */
function definitionBody(spec: string, name: string): string | undefined {
	const lines = maskTlaComments(spec).split(/\r?\n/);
	const header = new RegExp(`^${name.replace(/\W/g, "\\$&")}(\\([^)]*\\))?\\s*==`);
	const start = lines.findIndex(line => header.test(line));
	if (start === -1) return undefined;
	const body: string[] = [(lines[start] as string).replace(header, "")];
	for (const line of lines.slice(start + 1)) {
		if (/^\S/.test(line)) break;
		body.push(line);
	}
	return body.join("\n").trim();
}

/**
 * Whether every PROPERTY a config checks (those in `only`, when given) reads like a safety property: an action
 * property `[][...]_vars` or an invariant `[]P`, with no `<>`, `~>` or fairness. TLC checks those while it explores,
 * so they run with several workers; a liveness property is checked on the finished graph by one thread. This only
 * picks the worker count: a wrong answer changes the time, never a verdict.
 */
export function safetyOnly(configText: string, specText: string, only?: string[]): boolean {
	const { properties } = parseCfg(configText);
	return properties
		.filter(name => only === undefined || only.includes(name))
		.every(name => {
			const body = definitionBody(specText, name);
			return body !== undefined && /^\[\]/.test(body) && !NOT_SAFETY.test(body);
		});
}

export interface ToolsInfo {
	tlaVersion: string;
	javaMajor: number;
	javaSource: string;
}

/** A TLC run as a unit job stores it. `configUsed` is relative to the spec's folder. */
export interface StoredRun {
	code: number | null;
	result: TlcResult;
	/** The tail of TLC's output: enough for a failure report. */
	text: string;
	configUsed: string;
	durationMs: number;
	spawnError?: string;
}

interface VerdictBase {
	version: number;
	model: string;
	unit: string;
	name: string;
	/** The digest of the check's input; empty for a unit that could not be applied. */
	key: string;
	/** True when the verdict was taken from the cache instead of running TLC. */
	cached: boolean;
	workers: string;
	tools: ToolsInfo;
}

export interface RowVerdict extends VerdictBase {
	kind: "row";
	run: StoredRun;
}

export interface CheckVerdict extends VerdictBase {
	kind: "baseline" | "config-baseline" | "mutation";
	durationMs: number;
	result: UnitResult;
}

export type Verdict = RowVerdict | CheckVerdict;

const TEXT_TAIL = 20_000;

export function storedRun(run: TlcRun, specDir: string): StoredRun {
	return {
		code: run.code,
		result: run.result,
		text: run.text.length > TEXT_TAIL ? run.text.slice(-TEXT_TAIL) : run.text,
		configUsed: path.relative(specDir, run.configUsed),
		durationMs: run.durationMs,
		...(run.spawnError ? { spawnError: run.spawnError } : {}),
	};
}

export function runOf(verdict: RowVerdict, specDir: string): TlcRun {
	const { run } = verdict;
	return {
		code: run.code,
		result: run.result,
		text: run.text,
		configUsed: path.resolve(specDir, run.configUsed),
		durationMs: run.durationMs,
		...(verdict.cached ? { cached: true } : {}),
		...(run.spawnError ? { spawnError: run.spawnError } : {}),
	};
}

function fileOf(root: string, model: string, unit: string): string {
	return path.join(root, model, `${unit}.json`);
}

export function writeVerdict(root: string, verdict: Verdict): string {
	const file = fileOf(root, verdict.model, verdict.unit);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(verdict)}\n`);
	return file;
}

function parseVerdict(value: unknown, where: string): Verdict {
	const bad = (why: string): never => {
		throw new Error(`${where}: not a verdict of this version (${why})`);
	};
	if (!isRecord(value) || value.version !== VERDICT_VERSION) return bad("version");
	if (typeof value.model !== "string" || typeof value.unit !== "string" || typeof value.name !== "string")
		return bad("model, unit and name");
	if (!isRecord(value.tools)) return bad("tools");
	if (value.kind === "row") {
		if (!isRecord(value.run) || !isRecord(value.run.result) || typeof value.run.result.outcome !== "string")
			return bad("run");
		return value as unknown as RowVerdict;
	}
	if (value.kind === "baseline" || value.kind === "config-baseline" || value.kind === "mutation") {
		if (!isRecord(value.result)) return bad("result");
		return value as unknown as CheckVerdict;
	}
	return bad("kind");
}

/** The verdict of a unit, or `undefined` when its job wrote none. A file that is not a verdict of this version throws. */
export function readVerdict(root: string, model: string, unit: string): Verdict | undefined {
	const file = fileOf(root, model, unit);
	if (!fs.existsSync(file)) return undefined;
	const verdict = parseVerdict(JSON.parse(fs.readFileSync(file, "utf8")), file);
	if (verdict.model !== model || verdict.unit !== unit)
		throw new Error(`${file}: it holds the verdict of ${verdict.model}/${verdict.unit}`);
	return verdict;
}

/** The recorded result of every unit of a model's mutation run, by unit id (`undefined`: no verdict). */
export function recordedResults(root: string, model: string, unitIds: string[]): UnitResults {
	return new Map(
		unitIds.map(id => {
			const verdict = readVerdict(root, model, id);
			return [id, verdict && verdict.kind !== "row" ? verdict.result : undefined];
		}),
	);
}

/** The banner the row runs of a model printed, from the first verdict that has one. */
export function recordedBanner(root: string, model: string, specName: string, unitIds: string[]): string | undefined {
	for (const id of unitIds) {
		const verdict = readVerdict(root, model, id);
		if (verdict?.kind === "row")
			return `TLC (tla2tools release ${verdict.tools.tlaVersion})  java ${verdict.tools.javaMajor} (${verdict.tools.javaSource})  spec ${specName}`;
	}
	return undefined;
}

/** A cache entry is a verdict stored under the digest of its input. */
export function cacheGet(dir: string, key: string): Verdict | undefined {
	const file = path.join(dir, `${key}.json`);
	if (!fs.existsSync(file)) return undefined;
	try {
		const entry: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!isRecord(entry) || entry.key !== key) return undefined;
		const verdict = parseVerdict(entry.verdict, file);
		return verdict.key === key ? verdict : undefined;
	} catch {
		return undefined;
	}
}

export function cachePut(dir: string, key: string, verdict: Verdict): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${key}.json`), `${JSON.stringify({ key, verdict })}\n`);
}

export interface PlannedUnit {
	model: string;
	unit: string;
	kind: UnitKind;
	/** The job's title in the Actions list. */
	label: string;
	/** What the unit may run for, in seconds. */
	timeoutSec: number;
	/** What the unit is expected to take, in seconds: measured (`shard-costs.json`) or a guess by kind. */
	estimateSec: number;
	workers: string;
	/** The digest of the unit's input. */
	key: string;
}

export interface PlanJob {
	/** A name for the job's verdict artifact. */
	id: string;
	label: string;
	units: string[];
	/** The cache key of the job (its unit's digest, or the digest of its units'). */
	key: string;
	/** `timeout-minutes` for the job. */
	timeoutMin: number;
}

/** GitHub's matrix limit: more jobs than this cannot be one matrix. */
export const MATRIX_LIMIT = 256;

/** The longest a job may run, with the minutes its set-up needs on top of its units. */
const JOB_MINUTES = { setup: 12, max: 350 };

function minutesFor(units: PlannedUnit[]): number {
	const seconds = units.reduce((sum, unit) => sum + unit.timeoutSec, 0);
	return Math.min(JOB_MINUTES.max, Math.ceil(seconds / 60) + JOB_MINUTES.setup);
}

/** What a unit costs beyond its TLC time: the JVM's start and the files it reads and writes. */
const UNIT_OVERHEAD_SEC = 8;

export interface PackOptions {
	/** A unit expected to take at least this long gets a job of its own (and its own cache entry). */
	heavySec: number;
	/** The shorter units share jobs of about this many seconds. */
	targetSec: number;
	limit: number;
}

export const PACK_DEFAULTS: PackOptions = { heavySec: 100, targetSec: 240, limit: MATRIX_LIMIT };

function jobOf(units: PlannedUnit[], id: string, label: string): PlanJob {
	return {
		id,
		label,
		units: units.map(unit => unitRef(unit.model, unit.unit)),
		key: jobKey(units.map(unit => unit.key)),
		timeoutMin: minutesFor(units),
	};
}

/**
 * The jobs of a plan. A runner is the scarce thing (a few dozen at a time for the whole account, each starting
 * seconds after the last), so a job per unit would leave the long ones waiting behind the short ones: units expected
 * to take `heavySec` or more get a job each, heaviest first; the rest are dealt, longest first, to the least loaded of
 * as many jobs as `targetSec` asks for. Past `limit` jobs (a matrix's 256) everything is dealt over `limit`.
 */
export function packUnits(units: PlannedUnit[], options: Partial<PackOptions> = {}): PlanJob[] {
	const { heavySec, targetSec, limit } = { ...PACK_DEFAULTS, ...options };
	const byCost = [...units].sort((a, b) => b.estimateSec - a.estimateSec);
	const heavy = byCost.filter(unit => unit.estimateSec >= heavySec);
	const light = byCost.filter(unit => unit.estimateSec < heavySec);
	const jobs: PlanJob[] = heavy.map(unit => jobOf([unit], slug(`${unit.model}--${unit.unit}`, 90), unit.label));
	if (light.length > 0) {
		const total = light.reduce((sum, unit) => sum + unit.estimateSec + UNIT_OVERHEAD_SEC, 0);
		const bins: PlannedUnit[][] = Array.from({ length: Math.max(1, Math.ceil(total / targetSec)) }, () => []);
		const load = bins.map(() => 0);
		for (const unit of light) {
			const lightest = load.indexOf(Math.min(...load));
			bins[lightest]?.push(unit);
			load[lightest] = (load[lightest] ?? 0) + unit.estimateSec + UNIT_OVERHEAD_SEC;
		}
		for (const [index, bin] of bins.entries()) {
			const models = [...new Set(bin.map(unit => unit.model))].join(", ");
			jobs.push(jobOf(bin, `short-${index + 1}`, `${bin.length} short checks (${models})`));
		}
	}
	if (jobs.length <= limit) return jobs;
	const every = [...heavy, ...light];
	const groups: PlannedUnit[][] = Array.from({ length: limit }, () => []);
	for (const [index, unit] of every.entries()) groups[index % limit]?.push(unit);
	return groups.map((group, index) =>
		jobOf(group, `chunk-${index + 1}`, `${group.length} checks (${group[0]?.label}, ...)`),
	);
}
