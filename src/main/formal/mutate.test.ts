/**
 * The mutation runner: DETECTED, MISSED, UNCOVERED, WAIVED and INVALID with a fake checker, the exit codes, and the
 * command-kind checker through the real `mutate.ts` under Bun.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	applyMutation,
	type Checker,
	type CheckOutcome,
	type MutationSpec,
	mutationExitCode,
	parseMutations,
	runMutations,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/mutate-core";

const SKILL = path.join(__dirname, "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "formal-mutate-"));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

/** A model is a text file of guards; the fake checker fails on the property whose guard is missing. */
const MODEL = "guard A\nguard B\ncomment: unrelated\n";
const GUARDS: Record<string, string> = { "guard A": "PropA", "guard B": "PropB" };

const fakeChecker: Checker = async (_dir, model) => {
	const text = fs.readFileSync(model, "utf8");
	if (text.includes("garbage")) return { status: "error", violated: [], detail: "parse error" };
	const missing = Object.entries(GUARDS).filter(([guard]) => !text.includes(guard));
	if (missing.length === 0) return { status: "pass", violated: [], detail: "ok" };
	return { status: "fail", violated: missing.map(([, property]) => property), detail: "violated" };
};

function folder(): { root: string; model: string } {
	const root = fs.mkdtempSync(path.join(temp, "m-"));
	const model = path.join(root, "model.txt");
	fs.writeFileSync(model, MODEL);
	return { root, model };
}

function spec(mutations: unknown[], extra: Record<string, unknown> = {}): MutationSpec {
	return parseMutations({
		checker: { kind: "command", command: ["unused"] },
		properties: ["PropA", "PropB"],
		mutations,
		...extra,
	});
}

describe("runMutations with a fake checker", () => {
	it("detects mutations that break their property, and credits every property", async () => {
		const { root, model } = folder();
		const mutations = spec([
			{ name: "drop-a", search: "guard A\n", replace: "", breaks: "PropA" },
			{ name: "drop-b", search: "guard B\n", replace: "", breaks: ["PropB", "PropC"] },
		]);
		const report = await runMutations({
			root,
			model,
			spec: mutations,
			properties: ["PropA", "PropB"],
			check: fakeChecker,
		});
		expect(report.baseline.status).toBe("pass");
		expect(report.results.map(result => [result.name, result.status, result.violated])).toEqual([
			["drop-a", "DETECTED", ["PropA"]],
			["drop-b", "DETECTED", ["PropB"]],
		]);
		expect(report.properties.map(property => [property.name, property.status])).toEqual([
			["PropA", "covered"],
			["PropB", "covered"],
		]);
		expect(mutationExitCode(report)).toBe(0);
		expect(fs.readFileSync(model, "utf8")).toBe(MODEL);
	});

	it("reports MISSED when the model still passes, and when it fails on another property", async () => {
		const { root, model } = folder();
		const mutations = spec([
			{ name: "touch-comment", search: "unrelated", replace: "changed", breaks: "PropA" },
			{ name: "wrong-property", search: "guard B\n", replace: "", breaks: "PropA" },
		]);
		const report = await runMutations({
			root,
			model,
			spec: mutations,
			properties: ["PropA", "PropB"],
			check: fakeChecker,
		});
		expect(report.results.map(result => result.status)).toEqual(["MISSED", "MISSED"]);
		expect(report.results[0]?.detail).toContain("still passes");
		expect(report.results[1]?.detail).toContain("failed on PropB, not on PropA");
		expect(mutationExitCode(report)).toBe(1);
	});

	it("reports UNCOVERED for a property no mutation breaks, and WAIVED with a reason", async () => {
		const { root, model } = folder();
		const mutations = spec([{ name: "drop-a", search: "guard A\n", replace: "", breaks: "PropA" }], {
			properties: ["PropA", "PropB", "PropC"],
			waive: { PropC: "type invariant, covered by the compiler" },
		});
		const report = await runMutations({
			root,
			model,
			spec: mutations,
			properties: ["PropA", "PropB", "PropC"],
			check: fakeChecker,
		});
		expect(report.properties.map(property => [property.name, property.status])).toEqual([
			["PropA", "covered"],
			["PropB", "UNCOVERED"],
			["PropC", "WAIVED"],
		]);
		expect(mutationExitCode(report)).toBe(1);
	});

	it("reports INVALID for a search that does not match, matches twice, or yields an unparsable model", async () => {
		const { root, model } = folder();
		fs.writeFileSync(model, `${MODEL}guard A\n`);
		const mutations = spec([
			{ name: "absent", search: "nothing like this", replace: "x", breaks: "PropA" },
			{ name: "twice", search: "guard A", replace: "x", breaks: "PropA" },
			{ name: "both", search: "guard A", replace: "x", all: true, breaks: "PropA" },
			{ name: "garbage", search: "guard B", replace: "garbage", breaks: "PropB" },
		]);
		const report = await runMutations({ root, model, spec: mutations, properties: [], check: fakeChecker });
		expect(report.results.map(result => result.status)).toEqual(["INVALID", "INVALID", "DETECTED", "INVALID"]);
		expect(report.results[0]?.detail).toContain("does not occur");
		expect(report.results[1]?.detail).toContain("occurs 2 times");
		expect(report.results[3]?.detail).toContain("not checkable");
		expect(mutationExitCode(report)).toBe(2);
	});

	it("refuses to judge any mutation while the unmutated model fails", async () => {
		const { root, model } = folder();
		fs.writeFileSync(model, "guard A\n");
		const report = await runMutations({
			root,
			model,
			spec: spec([{ name: "m", search: "guard A", replace: "x", breaks: "PropA" }]),
			properties: ["PropA"],
			check: fakeChecker,
		});
		expect(report.baseline.status).toBe("fail");
		expect(report.results).toEqual([]);
		expect(mutationExitCode(report)).toBe(1);
	});

	it("stops with UNAVAILABLE when the checker cannot be prepared", async () => {
		const { root, model } = folder();
		const unavailable: Checker = async (): Promise<CheckOutcome> => ({
			status: "unavailable",
			violated: [],
			detail: "offline",
		});
		const report = await runMutations({
			root,
			model,
			spec: spec([{ name: "m", search: "guard A", replace: "x", breaks: "PropA" }]),
			properties: ["PropA"],
			check: unavailable,
		});
		expect(report.unavailable).toBe(true);
		expect(mutationExitCode(report)).toBe(3);
	});

	it("applies a multi-line search to a CRLF file", () => {
		expect(applyMutation("a\r\nb\r\nc\r\n", { search: "a\nb", replace: "x\ny", all: false })).toEqual({
			ok: true,
			text: "x\r\ny\r\nc\r\n",
		});
	});

	it("rejects a malformed mutations file with the field named", () => {
		expect(() => parseMutations({ checker: { kind: "lean" }, mutations: [] })).toThrow(/properties/);
		expect(() =>
			parseMutations({
				checker: { kind: "tlc" },
				mutations: [{ name: "a", search: "x", replace: "x", breaks: "P" }],
			}),
		).toThrow(/does not change/);
		expect(() =>
			parseMutations({ checker: { kind: "tlc" }, mutations: [{ name: "a", search: "x", replace: "y" }] }),
		).toThrow(/breaks/);
		expect(() => parseMutations({ checker: { kind: "tlc" }, mutations: [], waive: { A: "" } })).toThrow();
		expect(() => parseMutations({ checker: { kind: "other" }, mutations: [] })).toThrow(/unknown checker kind/);
	});
});

describe("mutate.ts under Bun with a command checker", () => {
	const checker = path.join(temp, "checker.ts");
	fs.writeFileSync(
		checker,
		[
			'import fs from "node:fs";',
			"const text = fs.readFileSync(process.argv[3], 'utf8');",
			"if (text.includes('offline')) process.exit(3);",
			"const missing = [['guard A', 'PropA'], ['guard B', 'PropB']].filter(([guard]) => !text.includes(guard));",
			"for (const [, name] of missing) console.log('VIOLATED: ' + name);",
			"process.exit(missing.length ? 1 : 0);",
			"",
		].join("\n"),
	);

	function exec(mutations: unknown[], extra: Record<string, unknown> = {}): { code: number | null; out: string } {
		const { root, model } = folder();
		const file = path.join(root, "mutations.json");
		fs.writeFileSync(
			file,
			JSON.stringify({
				checker: { kind: "command", command: ["bun", checker, "{dir}", "{model}"] },
				properties: ["PropA", "PropB"],
				mutations,
				...extra,
			}),
		);
		const run = spawnSync("bun", [path.join(SKILL, "scripts/mutate.ts"), model, file], { encoding: "utf8" });
		return { code: run.status, out: run.stdout + run.stderr };
	}

	it("exits 0 and prints DETECTED for every mutation when all properties are covered", () => {
		const run = exec([
			{ name: "drop-a", search: "guard A\n", replace: "", breaks: "PropA" },
			{ name: "drop-b", search: "guard B\n", replace: "", breaks: "PropB" },
		]);
		expect(run.code).toBe(0);
		expect(run.out).toContain("DETECTED drop-a");
		expect(run.out).toContain("2 of 2 mutations detected");
	});

	it("exits 1 on MISSED and UNCOVERED, 2 on INVALID, 3 on UNAVAILABLE, 2 on usage errors", () => {
		const missed = exec([{ name: "noop", search: "unrelated", replace: "other", breaks: "PropA" }]);
		expect(missed.code).toBe(1);
		expect(missed.out).toContain("MISSED   noop");
		expect(missed.out).toContain("UNCOVERED PropA");
		const uncovered = exec([{ name: "drop-a", search: "guard A\n", replace: "", breaks: "PropA" }]);
		expect(uncovered.code).toBe(1);
		expect(uncovered.out).toContain("UNCOVERED PropB");
		expect(exec([{ name: "absent", search: "not there", replace: "x", breaks: "PropA" }]).code).toBe(2);
		expect(exec([{ name: "off", search: "unrelated", replace: "offline", breaks: "PropA" }]).code).toBe(3);
		const usage = spawnSync("bun", [path.join(SKILL, "scripts/mutate.ts")], { encoding: "utf8" });
		expect(usage.status).toBe(2);
	});
});
