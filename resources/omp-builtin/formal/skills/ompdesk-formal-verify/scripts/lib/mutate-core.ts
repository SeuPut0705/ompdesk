import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "./json";
import { poolPromises } from "./pool";
import { onInterrupt } from "./proc";
import { removeTree } from "./scratch";

export interface Mutation {
	name: string;
	why?: string;
	/** File to change, relative to the checker root (the model's folder; the project folder for Lean); default: the model file. */
	file?: string;
	search: string;
	replace: string;
	/** Replace every occurrence (default: the search text must occur exactly once). */
	all: boolean;
	/** The properties this mutation must break: the checker has to fail on one of them. */
	breaks: string[];
	/** TLC only: run this config instead of the checker's. */
	config?: string;
	/** TLC only: check this mutation with `CHECK_DEADLOCK FALSE` (a liveness property cannot fail on a model that deadlocks first). */
	deadlock?: boolean;
	/** TLC only: check this mutation under a config derived from the base one that keeps only the `breaks` properties. */
	isolate?: boolean;
	/** Why this mutation changes no behavior (the mutated model means the same): it is recorded as EQUIVALENT, not MISSED. */
	equivalent?: string;
}

export type CheckerSpec =
	| { kind: "tlc"; config?: string; workers?: string; timeoutSec?: number; deadlock?: boolean; root?: string }
	| { kind: "lean"; project?: string; allowNative?: boolean; root?: string }
	| { kind: "command"; command: string[]; root?: string };

export interface MutationSpec {
	checker: CheckerSpec;
	/** Properties that need a mutation; for TLC the default is the INVARIANT and PROPERTY names of the config. */
	properties?: string[];
	waive: Record<string, string>;
	mutations: Mutation[];
}

/** What one checker run says about one copy of the model. */
export interface CheckOutcome {
	status: "pass" | "fail" | "error" | "unavailable";
	/** The properties it failed on, when it names them. */
	violated: string[];
	detail: string;
}

/** Runs the checker on a copy: `dir` is the copy of the model's root folder, `model` the model file inside it. */
export type Checker = (dir: string, model: string, mutation?: Mutation) => Promise<CheckOutcome>;

export type MutationStatus = "DETECTED" | "MISSED" | "EQUIVALENT" | "INVALID";

export interface MutationResult {
	name: string;
	status: MutationStatus;
	violated: string[];
	detail: string;
}

export interface PropertyCoverage {
	name: string;
	status: "covered" | "UNCOVERED" | "WAIVED";
	by: string[];
	reason?: string;
}

export interface MutationReport {
	baseline: CheckOutcome;
	results: MutationResult[];
	properties: PropertyCoverage[];
	unavailable: boolean;
}

function strings(value: unknown, where: string): string[] {
	const list = typeof value === "string" ? [value] : value;
	if (!Array.isArray(list) || list.length === 0 || list.some(item => typeof item !== "string" || item === "")) {
		throw new Error(`mutations: ${where} must be a non-empty string or array of strings`);
	}
	return list as string[];
}

/** Validates a mutations file's JSON; the error names the first bad field. */
export function parseMutations(input: unknown): MutationSpec {
	if (!isRecord(input)) throw new Error("mutations: the file must be a JSON object");
	const checker = input.checker;
	if (!isRecord(checker) || typeof checker.kind !== "string") throw new Error('mutations: "checker" needs a "kind"');
	let spec: CheckerSpec;
	const root = typeof checker.root === "string" ? { root: checker.root } : {};
	if (checker.kind === "tlc") {
		spec = {
			kind: "tlc",
			...(typeof checker.config === "string" ? { config: checker.config } : {}),
			...(checker.workers === undefined ? {} : { workers: String(checker.workers) }),
			...(typeof checker.timeoutSec === "number" ? { timeoutSec: checker.timeoutSec } : {}),
			...(typeof checker.deadlock === "boolean" ? { deadlock: checker.deadlock } : {}),
			...root,
		};
	} else if (checker.kind === "lean") {
		spec = {
			kind: "lean",
			...(typeof checker.project === "string" ? { project: checker.project } : {}),
			...(checker.allowNative === true ? { allowNative: true } : {}),
			...root,
		};
	} else if (checker.kind === "command") {
		spec = { kind: "command", command: strings(checker.command, "checker.command"), ...root };
	} else {
		throw new Error(`mutations: unknown checker kind ${checker.kind} (tlc, lean, command)`);
	}
	const properties = input.properties === undefined ? undefined : strings(input.properties, "properties");
	if (spec.kind !== "tlc" && !properties)
		throw new Error(`mutations: "properties" is required for the ${spec.kind} checker`);
	const waive: Record<string, string> = {};
	if (input.waive !== undefined) {
		if (!isRecord(input.waive)) throw new Error('mutations: "waive" must map a property to the reason it is waived');
		for (const [name, reason] of Object.entries(input.waive)) {
			if (typeof reason !== "string" || reason.trim() === "")
				throw new Error(`mutations: waive.${name} needs a reason`);
			waive[name] = reason;
		}
	}
	if (!Array.isArray(input.mutations) || input.mutations.length === 0)
		throw new Error('mutations: "mutations" must be a non-empty array');
	const names: string[] = [];
	const mutations = input.mutations.map((entry: unknown, index: number): Mutation => {
		const where = `mutations[${index}]`;
		if (!isRecord(entry)) throw new Error(`mutations: ${where} must be an object`);
		if (typeof entry.name !== "string" || entry.name === "") throw new Error(`mutations: ${where}.name is required`);
		if (names.includes(entry.name)) throw new Error(`mutations: duplicate mutation name ${entry.name}`);
		names.push(entry.name);
		if (typeof entry.search !== "string" || entry.search === "")
			throw new Error(`mutations: ${where}.search must be non-empty text`);
		if (typeof entry.replace !== "string")
			throw new Error(`mutations: ${where}.replace must be text (empty to delete)`);
		if (entry.search === entry.replace) throw new Error(`mutations: ${where} does not change anything`);
		if (entry.equivalent !== undefined && (typeof entry.equivalent !== "string" || entry.equivalent.trim() === ""))
			throw new Error(`mutations: ${where}.equivalent needs the reason the mutant means the same as the model`);
		if (entry.deadlock !== undefined && typeof entry.deadlock !== "boolean")
			throw new Error(`mutations: ${where}.deadlock must be true or false`);
		if (entry.isolate !== undefined && typeof entry.isolate !== "boolean")
			throw new Error(`mutations: ${where}.isolate must be true or false`);
		return {
			name: entry.name,
			search: entry.search,
			replace: entry.replace,
			all: entry.all === true,
			breaks:
				entry.equivalent !== undefined && entry.breaks === undefined
					? []
					: strings(entry.breaks, `${where}.breaks`),
			...(typeof entry.equivalent === "string" ? { equivalent: entry.equivalent } : {}),
			...(typeof entry.deadlock === "boolean" ? { deadlock: entry.deadlock } : {}),
			...(entry.isolate === true ? { isolate: true } : {}),
			...(typeof entry.why === "string" ? { why: entry.why } : {}),
			...(typeof entry.file === "string" ? { file: entry.file } : {}),
			...(typeof entry.config === "string" ? { config: entry.config } : {}),
		};
	});
	return { checker: spec, ...(properties ? { properties } : {}), waive, mutations };
}

/**
 * `source` with every TLA+ comment (`\* to the end of the line`, `(* ... *)` with nesting) blanked to spaces, newlines
 * and length kept. A string literal is code: `"\* x"` is not a comment.
 */
export function maskTlaComments(source: string): string {
	let out = "";
	let depth = 0;
	let i = 0;
	while (i < source.length) {
		const ch = source[i] as string;
		if (depth > 0) {
			if (source.startsWith("(*", i)) {
				depth++;
				out += "  ";
				i += 2;
			} else if (source.startsWith("*)", i)) {
				depth--;
				out += "  ";
				i += 2;
			} else {
				out += ch === "\n" || ch === "\r" ? ch : " ";
				i++;
			}
		} else if (source.startsWith("(*", i)) {
			depth = 1;
			out += "  ";
			i += 2;
		} else if (source.startsWith("\\*", i)) {
			while (i < source.length && source[i] !== "\n" && source[i] !== "\r") {
				out += " ";
				i++;
			}
		} else if (ch === '"') {
			out += ch;
			i++;
			while (i < source.length && source[i] !== '"') {
				const width = source[i] === "\\" && i + 1 < source.length ? 2 : 1;
				out += source.slice(i, i + width);
				i += width;
			}
			if (i < source.length) {
				out += '"';
				i++;
			}
		} else {
			out += ch;
			i++;
		}
	}
	return out;
}

function positions(text: string, needle: string): number[] {
	const found: number[] = [];
	for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) found.push(at);
	return found;
}

/**
 * Applies one search/replace; fails (with the reason) unless the search text occurs once, or `all` is set. In a
 * `.tla` file (`file` names it) a match counts only when it contains something outside comments (a search may run
 * from code into its trailing `\* comment`): a change to a comment alone cannot alter the model, so a search whose
 * matches all lie inside comments is rejected instead of ending as a MISSED mutation.
 */
export function applyMutation(
	source: string,
	mutation: Pick<Mutation, "search" | "replace" | "all">,
	file?: string,
): { ok: true; text: string } | { ok: false; reason: string } {
	// A Windows checkout may hold CRLF files: write the search text with the file's own line endings.
	const crlf = source.includes("\r\n");
	const eol = (text: string): string => (crlf ? text.replace(/\r?\n/g, "\r\n") : text);
	const search = eol(mutation.search);
	const replace = eol(mutation.replace);
	const all = positions(source, search);
	const masked = file?.endsWith(".tla") ? maskTlaComments(source) : undefined;
	const found = masked ? all.filter(at => masked.slice(at, at + search.length).trim() !== "") : all;
	if (found.length === 0) {
		return {
			ok: false,
			reason:
				all.length > 0
					? "the search text matches only inside comments of the .tla file: a comment cannot change the model, search the code"
					: "the search text does not occur in the file",
		};
	}
	if (found.length > 1 && !mutation.all) {
		return { ok: false, reason: `the search text occurs ${found.length} times; make it unique or set "all": true` };
	}
	let text = "";
	let from = 0;
	for (const at of found) {
		text += source.slice(from, at) + replace;
		from = at + search.length;
	}
	return { ok: true, text: text + source.slice(from) };
}

const SKIP = new Set([".git", "node_modules", ".tlc-out", "states"]);

/** Copies a model folder (without VCS and scratch folders). */
export function copyModel(from: string, to: string): void {
	fs.cpSync(from, to, {
		recursive: true,
		filter: source => {
			const base = path.basename(source);
			return !SKIP.has(base) && !/_TTrace_/.test(base);
		},
	});
}

function detailOf(outcome: CheckOutcome): string {
	return outcome.detail.trim().split(/\r?\n/).slice(0, 3).join(" | ");
}

/** The baseline a mutation's own config needs: the unmutated model under that config, isolation and deadlock setting. */
function baselineKey(mutation: Mutation): string | undefined {
	if (mutation.config === undefined) return undefined;
	return JSON.stringify([
		mutation.config,
		mutation.isolate ? [...mutation.breaks].sort() : null,
		mutation.deadlock ?? null,
	]);
}

/**
 * Runs every mutation against a copy of the model. The unmutated model must pass first. A mutation is DETECTED
 * when the checker fails on a property it says it breaks, MISSED when the model still passes (or fails on
 * something else), INVALID when the search text does not match or the mutated model is not a valid model.
 * `jobs` checks run at once (default 1), each in its own copy; the results keep the order of the mutations file.
 */
export async function runMutations(options: {
	/** The model's root folder and the model file inside it. */
	root: string;
	model: string;
	spec: MutationSpec;
	/** Properties that need a mutation. */
	properties: string[];
	check: Checker;
	keep?: boolean;
	/** Receives warnings, such as a scratch folder that could not be removed (default: stderr). */
	log?: (line: string) => void;
	jobs?: number;
}): Promise<MutationReport & { workDir: string }> {
	const { root, model, spec, check } = options;
	const jobs = Math.max(1, options.jobs ?? 1);
	const warn = options.log ?? ((line: string) => console.error(line));
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-mutate-"));
	const unregister = options.keep
		? undefined
		: onInterrupt(() => {
				removeTree(work);
			});
	const report: MutationReport & { workDir: string } = {
		baseline: { status: "error", violated: [], detail: "not run" },
		results: [],
		properties: [],
		unavailable: false,
		workDir: work,
	};
	const discard = (dir: string): void => {
		if (options.keep) return;
		const failed = removeTree(dir);
		if (failed) warn(`WARN  ${failed}`);
	};
	try {
		const baseDir = path.join(work, "baseline");
		copyModel(root, baseDir);
		const relModel = path.relative(root, model);
		const baseModel = path.join(baseDir, relModel);
		report.baseline = await check(baseDir, baseModel);
		report.unavailable = report.baseline.status === "unavailable";
		if (report.baseline.status !== "pass") return report;
		// A mutation may run under its own config. The unmutated model must pass under that config too (with the
		// mutation's isolation and deadlock setting), or a mutation that changes nothing would be "detected" by a
		// config that fails on its own.
		const baselineOf = new Map<string, Mutation>();
		for (const mutation of spec.mutations) {
			const key = baselineKey(mutation);
			if (key !== undefined && !baselineOf.has(key)) baselineOf.set(key, mutation);
		}
		const keys = [...baselineOf.keys()];
		const outcomes = await Promise.all(
			poolPromises(keys, jobs, key => check(baseDir, baseModel, baselineOf.get(key) as Mutation)),
		);
		const baselines = new Map(keys.map((key, index) => [key, outcomes[index] as CheckOutcome]));
		if (outcomes.some(outcome => outcome.status === "unavailable")) {
			report.unavailable = true;
			return report;
		}
		let stopped = false;
		const judgeOne = async (mutation: Mutation, index: number): Promise<MutationResult | undefined> => {
			if (stopped) return undefined;
			const invalid = (detail: string, violated: string[] = []): MutationResult => ({
				name: mutation.name,
				status: "INVALID",
				violated,
				detail,
			});
			const key = baselineKey(mutation);
			const configBaseline = key === undefined ? undefined : baselines.get(key);
			if (configBaseline && configBaseline.status !== "pass") {
				return invalid(
					`the unmutated model does not pass under ${mutation.config} (${configBaseline.status}: ${detailOf(configBaseline)}), so a failure there proves nothing about this mutation`,
				);
			}
			const dir = path.join(work, `m${index}-${mutation.name.replace(/[^\w.-]+/g, "_")}`);
			try {
				copyModel(baseDir, dir);
				const target = path.join(dir, mutation.file ?? relModel);
				const outside = path.relative(dir, target);
				if (outside.startsWith("..") || path.isAbsolute(outside)) {
					return invalid(`the file ${mutation.file} is outside the model's folder`);
				}
				let source: string;
				try {
					source = fs.readFileSync(target, "utf8");
				} catch {
					return invalid(`cannot read ${mutation.file ?? relModel}`);
				}
				const applied = applyMutation(source, mutation, target);
				if (!applied.ok) return invalid(applied.reason);
				fs.writeFileSync(target, applied.text);
				const outcome = await check(dir, path.join(dir, relModel), mutation);
				if (outcome.status === "unavailable") {
					report.unavailable = true;
					stopped = true;
					return invalid(detailOf(outcome));
				}
				if (outcome.status === "error") return invalid(`the mutated model is not checkable: ${detailOf(outcome)}`);
				if (outcome.status === "pass") {
					return mutation.equivalent
						? {
								name: mutation.name,
								status: "EQUIVALENT",
								violated: [],
								detail: `no property notices it, as declared: ${mutation.equivalent}`,
							}
						: {
								name: mutation.name,
								status: "MISSED",
								violated: [],
								detail: "the checker still passes: the properties do not notice this change",
							};
				}
				if (mutation.equivalent) {
					return invalid(
						`declared equivalent (${mutation.equivalent}) but the checker fails${outcome.violated.length ? ` on ${outcome.violated.join(", ")}` : ""}: the claim is wrong, drop "equivalent" and treat it as a detected mutation`,
						outcome.violated,
					);
				}
				const hit = outcome.violated.filter(name => mutation.breaks.includes(name));
				if (hit.length > 0) {
					return { name: mutation.name, status: "DETECTED", violated: hit, detail: `failed on ${hit.join(", ")}` };
				}
				const got = outcome.violated.length ? outcome.violated.join(", ") : "an unnamed property";
				const deadlocked = outcome.violated.includes("deadlock") && !mutation.breaks.includes("deadlock");
				return {
					name: mutation.name,
					status: "MISSED",
					violated: outcome.violated,
					detail: `failed on ${got}, not on ${mutation.breaks.join(" or ")}${deadlocked ? ' (the mutation deadlocks the model before the property can fail: set "deadlock": false on it, or CHECK_DEADLOCK FALSE in its config)' : ""}`,
				};
			} finally {
				discard(dir);
			}
		};
		const judged = await Promise.all(poolPromises(spec.mutations, jobs, judgeOne));
		report.results = judged.filter((result): result is MutationResult => result !== undefined);
		const credited = new Map<string, string[]>();
		for (const result of report.results) {
			if (result.status !== "DETECTED") continue;
			for (const name of result.violated) credited.set(name, [...(credited.get(name) ?? []), result.name]);
		}
		for (const name of options.properties) {
			const by = credited.get(name) ?? [];
			if (by.length > 0) report.properties.push({ name, status: "covered", by });
			else if (spec.waive[name])
				report.properties.push({ name, status: "WAIVED", by: [], reason: spec.waive[name] });
			else report.properties.push({ name, status: "UNCOVERED", by: [] });
		}
		return report;
	} finally {
		unregister?.();
		discard(work);
	}
}

/** 0 all well, 1 a MISSED mutation, an UNCOVERED property or a failing baseline, 2 an INVALID mutation, 3 unavailable. */
export function mutationExitCode(report: MutationReport): number {
	if (report.unavailable) return 3;
	if (report.baseline.status !== "pass") return report.baseline.status === "error" ? 2 : 1;
	if (report.results.some(result => result.status === "INVALID")) return 2;
	if (report.results.some(result => result.status === "MISSED")) return 1;
	if (report.properties.some(property => property.status === "UNCOVERED")) return 1;
	return 0;
}
