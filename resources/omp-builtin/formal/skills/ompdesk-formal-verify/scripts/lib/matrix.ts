import { isRecord } from "./json";
import type { Outcome, TlcResult } from "./tlc-parse";

export type Expect = "pass" | "violation" | "invariant" | "deadlock" | "temporal" | "action";

export interface MatrixRun {
	name: string;
	config?: string;
	constants?: Record<string, string>;
	expect: Expect;
	/** The property the run must violate (`deadlock` for a deadlock). */
	property?: string;
	workers?: string;
	/** `false` adds `-deadlock`. */
	deadlock?: boolean;
	args?: string[];
	timeoutSec?: number;
}

const EXPECTS: readonly string[] = ["pass", "violation", "invariant", "deadlock", "temporal", "action"];

function text(value: unknown, where: string): string {
	if (typeof value !== "string" || value === "") throw new Error(`matrix: ${where} must be a non-empty string`);
	return value;
}

/** Validates a matrix file's JSON; the error names the first bad field. */
export function parseMatrix(input: unknown): MatrixRun[] {
	if (!isRecord(input) || !Array.isArray(input.runs) || input.runs.length === 0) {
		throw new Error('matrix: expected {"runs": [ ... ]} with at least one run');
	}
	const seen: string[] = [];
	return input.runs.map((entry: unknown, index: number): MatrixRun => {
		const where = `runs[${index}]`;
		if (!isRecord(entry)) throw new Error(`matrix: ${where} must be an object`);
		const name = text(entry.name, `${where}.name`);
		if (seen.includes(name)) throw new Error(`matrix: duplicate run name ${name}`);
		seen.push(name);
		const expect = entry.expect === undefined ? "pass" : entry.expect;
		if (typeof expect !== "string" || !EXPECTS.includes(expect)) {
			throw new Error(`matrix: ${where}.expect must be one of ${EXPECTS.join(", ")}`);
		}
		let constants: Record<string, string> | undefined;
		if (entry.constants !== undefined) {
			if (!isRecord(entry.constants)) throw new Error(`matrix: ${where}.constants must be an object`);
			constants = {};
			for (const [key, value] of Object.entries(entry.constants)) {
				if (typeof value !== "string")
					throw new Error(`matrix: ${where}.constants.${key} must be a TLC value string`);
				constants[key] = value;
			}
		}
		if (
			entry.args !== undefined &&
			(!Array.isArray(entry.args) || entry.args.some((arg: unknown) => typeof arg !== "string"))
		) {
			throw new Error(`matrix: ${where}.args must be an array of strings`);
		}
		if (entry.timeoutSec !== undefined && (typeof entry.timeoutSec !== "number" || entry.timeoutSec <= 0)) {
			throw new Error(`matrix: ${where}.timeoutSec must be a positive number`);
		}
		if (entry.deadlock !== undefined && typeof entry.deadlock !== "boolean") {
			throw new Error(`matrix: ${where}.deadlock must be a boolean`);
		}
		return {
			name,
			expect: expect as Expect,
			...(entry.config === undefined ? {} : { config: text(entry.config, `${where}.config`) }),
			...(constants ? { constants } : {}),
			...(entry.property === undefined ? {} : { property: text(entry.property, `${where}.property`) }),
			...(entry.workers === undefined ? {} : { workers: String(entry.workers) }),
			...(entry.deadlock === undefined ? {} : { deadlock: entry.deadlock }),
			...(entry.args === undefined ? {} : { args: entry.args as string[] }),
			...(entry.timeoutSec === undefined ? {} : { timeoutSec: entry.timeoutSec }),
		};
	});
}

const VIOLATIONS: readonly Outcome[] = ["invariant", "deadlock", "temporal", "action", "assert"];

/** Did the run end the way the matrix said it would? */
export function judge(run: Pick<MatrixRun, "expect" | "property">, result: TlcResult): { ok: boolean; reason: string } {
	const got = result.property ? `${result.outcome} ${result.property}` : result.outcome;
	if (run.expect === "pass") {
		return result.outcome === "pass"
			? { ok: true, reason: "no violation" }
			: { ok: false, reason: `expected pass, got ${got}` };
	}
	const kindOk = run.expect === "violation" ? VIOLATIONS.includes(result.outcome) : result.outcome === run.expect;
	if (!kindOk) return { ok: false, reason: `expected ${run.expect}, got ${got}` };
	if (run.property) {
		const named = result.outcome === "deadlock" ? "deadlock" : result.property;
		if (named !== run.property) return { ok: false, reason: `expected ${run.expect} of ${run.property}, got ${got}` };
	}
	return { ok: true, reason: `${got} (as expected)` };
}
