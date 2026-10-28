import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "./json";

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
}

export type CheckerSpec =
	| { kind: "tlc"; config?: string; workers?: string; timeoutSec?: number; root?: string }
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

export type MutationStatus = "DETECTED" | "MISSED" | "INVALID";

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
		return {
			name: entry.name,
			search: entry.search,
			replace: entry.replace,
			all: entry.all === true,
			breaks: strings(entry.breaks, `${where}.breaks`),
			...(typeof entry.why === "string" ? { why: entry.why } : {}),
			...(typeof entry.file === "string" ? { file: entry.file } : {}),
			...(typeof entry.config === "string" ? { config: entry.config } : {}),
		};
	});
	return { checker: spec, ...(properties ? { properties } : {}), waive, mutations };
}

function occurrences(text: string, needle: string): number {
	let count = 0;
	for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
	return count;
}

/** Applies one search/replace; fails (with the reason) unless the search text occurs once, or `all` is set. */
export function applyMutation(
	source: string,
	mutation: Pick<Mutation, "search" | "replace" | "all">,
): { ok: true; text: string } | { ok: false; reason: string } {
	// A Windows checkout may hold CRLF files: write the search text with the file's own line endings.
	const crlf = source.includes("\r\n");
	const eol = (text: string): string => (crlf ? text.replace(/\r?\n/g, "\r\n") : text);
	const search = eol(mutation.search);
	const replace = eol(mutation.replace);
	const found = occurrences(source, search);
	if (found === 0) return { ok: false, reason: "the search text does not occur in the file" };
	if (found > 1 && !mutation.all) {
		return { ok: false, reason: `the search text occurs ${found} times; make it unique or set "all": true` };
	}
	return { ok: true, text: source.split(search).join(replace) };
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

/**
 * Runs every mutation against a copy of the model. The unmutated model must pass first. A mutation is DETECTED
 * when the checker fails on a property it says it breaks, MISSED when the model still passes (or fails on
 * something else), INVALID when the search text does not match or the mutated model is not a valid model.
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
	log?: (line: string) => void;
}): Promise<MutationReport & { workDir: string }> {
	const { root, model, spec, check } = options;
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-mutate-"));
	const baseDir = path.join(work, "baseline");
	copyModel(root, baseDir);
	const relModel = path.relative(root, model);
	const baseModel = path.join(baseDir, relModel);
	const baseline = await check(baseDir, baseModel);
	const report: MutationReport & { workDir: string } = {
		baseline,
		results: [],
		properties: [],
		unavailable: baseline.status === "unavailable",
		workDir: work,
	};
	try {
		if (baseline.status !== "pass") return report;
		const credited = new Map<string, string[]>();
		for (const mutation of spec.mutations) {
			const dir = path.join(work, `m-${mutation.name.replace(/[^\w.-]+/g, "_")}`);
			copyModel(baseDir, dir);
			const target = path.join(dir, mutation.file ?? relModel);
			let source: string;
			try {
				source = fs.readFileSync(target, "utf8");
			} catch {
				report.results.push({
					name: mutation.name,
					status: "INVALID",
					violated: [],
					detail: `cannot read ${mutation.file ?? relModel}`,
				});
				continue;
			}
			const applied = applyMutation(source, mutation);
			if (!applied.ok) {
				report.results.push({ name: mutation.name, status: "INVALID", violated: [], detail: applied.reason });
				continue;
			}
			fs.writeFileSync(target, applied.text);
			const outcome = await check(dir, path.join(dir, relModel), mutation);
			if (outcome.status === "unavailable") {
				report.unavailable = true;
				report.results.push({ name: mutation.name, status: "INVALID", violated: [], detail: detailOf(outcome) });
				break;
			}
			if (outcome.status === "error") {
				report.results.push({
					name: mutation.name,
					status: "INVALID",
					violated: [],
					detail: `the mutated model is not checkable: ${detailOf(outcome)}`,
				});
			} else if (outcome.status === "pass") {
				report.results.push({
					name: mutation.name,
					status: "MISSED",
					violated: [],
					detail: "the checker still passes: the properties do not notice this change",
				});
			} else {
				const hit = outcome.violated.filter(name => mutation.breaks.includes(name));
				if (hit.length > 0) {
					report.results.push({
						name: mutation.name,
						status: "DETECTED",
						violated: hit,
						detail: `failed on ${hit.join(", ")}`,
					});
					for (const name of hit) credited.set(name, [...(credited.get(name) ?? []), mutation.name]);
				} else {
					const got = outcome.violated.length ? outcome.violated.join(", ") : "an unnamed property";
					report.results.push({
						name: mutation.name,
						status: "MISSED",
						violated: outcome.violated,
						detail: `failed on ${got}, not on ${mutation.breaks.join(" or ")}`,
					});
				}
			}
			if (!options.keep) fs.rmSync(dir, { recursive: true, force: true });
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
		if (!options.keep) fs.rmSync(work, { recursive: true, force: true });
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
