/**
 * Spreading a verify-all run over jobs: the digest that decides whether two checks read the same input, the plan,
 * the recorded verdicts and the one report printed from them. No TLC runs here: the verdicts are written by hand, the
 * way `shard.ts run` writes them, and the mutation units are put together with a fake checker.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	assembleReport,
	type Checker,
	type CheckOutcome,
	type MutationSpec,
	parseMutations,
	planMutations,
	runMutations,
	runMutationUnit,
	type UnitResult,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/mutate-core";
import {
	type CheckVerdict,
	cacheGet,
	cachePut,
	checkDigest,
	chunkUnits,
	modulesDigest,
	normalizeTla,
	type PlannedUnit,
	parseUnitRef,
	type RowVerdict,
	readVerdict,
	rowUnitId,
	safetyOnly,
	VERDICT_VERSION,
	writeVerdict,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/shard";
import type { TlcResult } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/tlc-parse";
import {
	modelUnits,
	planUnits,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/shard";
import {
	parseArgs,
	main as verifyAll,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/verify-all";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "formal-shard-"));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const SPEC = [
	"---- MODULE A ----",
	"EXTENDS Naturals",
	"VARIABLE x",
	"",
	"\\* @code src/a.ts:1-9 the step",
	"Init == x = 0",
	"Step == /\\ x < 2",
	"        /\\ x' = x + 1",
	"Next == Step \\/ UNCHANGED x",
	"P == x < 3",
	"Q == x \\in Nat",
	"NoBack == [][x' >= x]_x",
	"Live == <>(x = 2)",
	"Spec == Init /\\ [][Next]_x",
	"====",
	"",
].join("\n");

describe("normalizeTla", () => {
	it("ignores comments, @code tags, trailing blanks, blank lines and line endings", () => {
		const edited = SPEC.replace(
			"\\* @code src/a.ts:1-9 the step",
			"\\* @code src/other.ts:40-58 where it lives now\n\\* and a longer note",
		)
			.replace("Init == x = 0", "Init == x = 0   \\* start")
			.replace("VARIABLE x", "(* a block\n   comment *)\nVARIABLE x\n\n\n")
			.replace(/\n/g, "\r\n");
		expect(normalizeTla(edited)).toBe(normalizeTla(SPEC));
	});

	it("changes with the code: a guard, an operator, indentation, a string", () => {
		const base = normalizeTla(SPEC);
		expect(normalizeTla(SPEC.replace("x < 2", "x < 3"))).not.toBe(base);
		expect(normalizeTla(SPEC.replace("Next == Step", "Next == Init"))).not.toBe(base);
		expect(normalizeTla(SPEC.replace("        /\\ x' = x + 1", "      /\\ x' = x + 1"))).not.toBe(base);
		expect(normalizeTla('S == "\\* not a comment"\n')).toContain('"\\* not a comment"');
	});
});

describe("checkDigest and modulesDigest", () => {
	const dir = path.join(temp, "digest");
	fs.mkdirSync(dir);
	const parts = { kind: "check", config: "INVARIANT P", options: { workers: "1" }, tools: "t" } as const;

	it("is the same for a comment-only edit and differs for anything TLC reads", () => {
		fs.writeFileSync(path.join(dir, "A.tla"), SPEC);
		const base = checkDigest({ ...parts, modules: modulesDigest(dir) });
		fs.writeFileSync(path.join(dir, "A.tla"), SPEC.replace("the step", "the step, retagged"));
		expect(checkDigest({ ...parts, modules: modulesDigest(dir) })).toBe(base);
		fs.writeFileSync(path.join(dir, "Other.tla"), "---- MODULE Other ----\n====\n");
		const withModule = checkDigest({ ...parts, modules: modulesDigest(dir) });
		expect(withModule).not.toBe(base);
		fs.rmSync(path.join(dir, "Other.tla"));
		const modules = modulesDigest(dir);
		expect(checkDigest({ ...parts, modules, config: "INVARIANT Q" })).not.toBe(base);
		expect(checkDigest({ ...parts, modules, options: { workers: "4" } })).not.toBe(base);
		expect(checkDigest({ ...parts, modules, tools: "other java" })).not.toBe(base);
		expect(checkDigest({ ...parts, modules, kind: "row" })).not.toBe(base);
		fs.writeFileSync(path.join(dir, "A.tla"), SPEC.replace("x < 2", "x < 3"));
		expect(checkDigest({ ...parts, modules: modulesDigest(dir) })).not.toBe(base);
	});
});

describe("safetyOnly", () => {
	it("takes invariants and box-action properties for safety, a liveness property for the other", () => {
		expect(safetyOnly("INVARIANT P Q", SPEC)).toBe(true);
		expect(safetyOnly("INVARIANT P\nPROPERTY NoBack", SPEC)).toBe(true);
		expect(safetyOnly("PROPERTY Live", SPEC)).toBe(false);
		expect(safetyOnly("PROPERTY NoBack Live", SPEC)).toBe(false);
		// The mutation keeps only the property it breaks: a liveness property it does not keep does not count.
		expect(safetyOnly("PROPERTY NoBack Live", SPEC, ["NoBack"])).toBe(true);
		// A property the spec does not define in plain text is not assumed to be safety.
		expect(safetyOnly("PROPERTY Missing", SPEC)).toBe(false);
	});
});

describe("unit refs and jobs", () => {
	it("names a unit by model and id", () => {
		expect(parseUnitRef("turn-resume/m3-fire-hold")).toEqual({ model: "turn-resume", unit: "m3-fire-hold" });
		expect(() => parseUnitRef("nothing")).toThrow(/<model>\/<unit>/);
		expect(rowUnitId(2, "a run: with/odd chars")).toBe("r2-a_run_with_odd_chars");
	});

	const unit = (index: number, timeoutSec = 60): PlannedUnit => ({
		model: "m",
		unit: `u${index}`,
		kind: "mutation",
		label: `m: u${index}`,
		timeoutSec,
		workers: "1",
		key: `key${index}`,
	});

	it("gives every unit its own job while they fit in a matrix", () => {
		const jobs = chunkUnits([unit(0, 600), unit(1, 180)], 256);
		expect(jobs.map(job => [job.id, job.units, job.key])).toEqual([
			["m--u0", ["m/u0"], "key0"],
			["m--u1", ["m/u1"], "key1"],
		]);
		expect(jobs[0]?.timeoutMin).toBe(22);
	});

	it("deals the units over `limit` jobs past it, each unit once, the first ones apart", () => {
		const units = Array.from({ length: 10 }, (_, index) => unit(index));
		const jobs = chunkUnits(units, 4);
		expect(jobs).toHaveLength(4);
		expect(jobs.flatMap(job => job.units).sort()).toEqual(units.map(item => `m/${item.unit}`).sort());
		expect(jobs.map(job => job.units[0])).toEqual(["m/u0", "m/u1", "m/u2", "m/u3"]);
		expect(new Set(jobs.map(job => job.key)).size).toBe(4);
		expect(chunkUnits(units, 256)).toHaveLength(10);
	});
});

describe("recorded verdicts and the cache", () => {
	const tools = { tlaVersion: "1.8.0", javaMajor: 17, javaSource: "system" };
	const verdict = (): RowVerdict => ({
		version: VERDICT_VERSION,
		kind: "row",
		model: "a",
		unit: "r0-x",
		name: "x",
		key: "k1",
		cached: false,
		workers: "1",
		tools,
		run: {
			code: 0,
			result: { outcome: "pass", stats: { distinct: 1 }, trace: [], errors: [], warnings: [] },
			text: "",
			configUsed: "A.cfg",
			durationMs: 5,
		},
	});

	it("round-trips a verdict, tells a missing one apart and refuses a foreign file", () => {
		const root = path.join(temp, "verdicts");
		writeVerdict(root, verdict());
		expect(readVerdict(root, "a", "r0-x")).toMatchObject({ kind: "row", name: "x" });
		expect(readVerdict(root, "a", "r1-y")).toBeUndefined();
		fs.writeFileSync(path.join(root, "a", "r2-z.json"), JSON.stringify({ version: 99 }));
		expect(() => readVerdict(root, "a", "r2-z")).toThrow(/not a verdict of this version/);
		fs.copyFileSync(path.join(root, "a", "r0-x.json"), path.join(root, "a", "r3-w.json"));
		expect(() => readVerdict(root, "a", "r3-w")).toThrow(/holds the verdict of a\/r0-x/);
	});

	it("serves a cache entry only under its own digest", () => {
		const cache = path.join(temp, "cache");
		expect(cacheGet(cache, "k1")).toBeUndefined();
		cachePut(cache, "k1", verdict());
		expect(cacheGet(cache, "k1")).toMatchObject({ kind: "row", key: "k1" });
		// The same file under another digest is a different input's verdict: never served.
		fs.copyFileSync(path.join(cache, "k1.json"), path.join(cache, "k2.json"));
		expect(cacheGet(cache, "k2")).toBeUndefined();
		fs.writeFileSync(path.join(cache, "k3.json"), "not json");
		expect(cacheGet(cache, "k3")).toBeUndefined();
	});
});

/** A mutation run's units, put together from separate runs, equal the in-process run. */
describe("assembleReport", () => {
	const MODEL = "guard A\nguard B\nguard C\n";
	const GUARDS: Record<string, string> = { "guard A": "PropA", "guard B": "PropB", "guard C": "PropC" };
	const fake: Checker = async (_dir, model, mutation) => {
		const text = fs.readFileSync(model, "utf8");
		const missing = Object.entries(GUARDS).filter(([guard]) => !text.includes(guard));
		// A mutation with its own config runs under one that fails by itself when asked to (`config` "bad.cfg").
		if (mutation?.config === "bad.cfg") return { status: "fail", violated: ["PropA"], detail: "bad config" };
		if (missing.length === 0) return { status: "pass", violated: [], detail: "ok" };
		return { status: "fail", violated: missing.map(([, property]) => property), detail: "violated" };
	};
	const spec = (mutations: unknown[]): MutationSpec =>
		parseMutations({
			checker: { kind: "command", command: ["unused"] },
			properties: ["PropA", "PropB", "PropC"],
			mutations,
		});

	async function viaUnits(mutationSpec: MutationSpec, root: string, model: string, check: Checker) {
		const plan = planMutations(mutationSpec);
		const work = fs.mkdtempSync(path.join(temp, "w-"));
		const results = new Map<string, UnitResult | undefined>();
		for (const unit of plan.units) results.set(unit.id, await runMutationUnit({ root, model, check, work }, unit));
		return assembleReport(mutationSpec, ["PropA", "PropB", "PropC"], plan, results);
	}

	it("gives the report the in-process run gives, invalid and equivalent mutations and own configs included", async () => {
		const root = fs.mkdtempSync(path.join(temp, "m-"));
		const model = path.join(root, "model.txt");
		fs.writeFileSync(model, MODEL);
		const mutationSpec = spec([
			{ name: "drop-a", search: "guard A\n", replace: "", breaks: "PropA" },
			{ name: "drop-b", search: "guard B\n", replace: "", breaks: ["PropB"] },
			{ name: "wrong-property", search: "guard C\n", replace: "", breaks: "PropA" },
			{ name: "no-such-text", search: "guard Z", replace: "", breaks: "PropA" },
			{ name: "nothing", search: "guard A", replace: "guard A  ", breaks: "PropA", equivalent: "same" },
			{ name: "under-bad-config", search: "guard A\n", replace: "", breaks: "PropA", config: "bad.cfg" },
		]);
		const direct = await runMutations({
			root,
			model,
			spec: mutationSpec,
			properties: ["PropA", "PropB", "PropC"],
			check: fake,
		});
		const { workDir: _workDir, ...inProcess } = direct;
		expect(await viaUnits(mutationSpec, root, model, fake)).toEqual(inProcess);
		expect(inProcess.results.map(result => [result.name, result.status])).toEqual([
			["drop-a", "DETECTED"],
			["drop-b", "DETECTED"],
			["wrong-property", "MISSED"],
			["no-such-text", "INVALID"],
			["nothing", "EQUIVALENT"],
			["under-bad-config", "INVALID"],
		]);
	});

	it("names the units: the baseline, one baseline per config, then the mutations", () => {
		const plan = planMutations(
			spec([
				{ name: "a", search: "x", replace: "y", breaks: "PropA", config: "c1.cfg" },
				{ name: "b", search: "x", replace: "y", breaks: "PropA", config: "c1.cfg" },
				{ name: "c", search: "x", replace: "y", breaks: "PropA", config: "c1.cfg", isolate: true },
				{ name: "d e", search: "x", replace: "y", breaks: "PropA" },
			]),
		);
		expect(plan.units.map(unit => unit.id)).toEqual(["baseline", "base1", "base2", "m0-a", "m1-b", "m2-c", "m3-d_e"]);
		expect([...plan.configBaselineOf]).toEqual([
			["a", "base1"],
			["b", "base1"],
			["c", "base2"],
		]);
	});

	it("reports a unit that never reported as an error, never as a pass", () => {
		const mutationSpec = spec([{ name: "a", search: "x", replace: "y", breaks: "PropA" }]);
		const plan = planMutations(mutationSpec);
		const pass: CheckOutcome = { status: "pass", violated: [], detail: "" };
		const noBaseline = assembleReport(mutationSpec, ["PropA"], plan, new Map());
		expect(noBaseline.baseline.status).toBe("error");
		const noMutation = assembleReport(mutationSpec, ["PropA"], plan, new Map([["baseline", { outcome: pass }]]));
		expect(noMutation.results).toEqual([
			{ name: "a", status: "INVALID", violated: [], detail: "no verdict was recorded for this mutation" },
		]);
	});
});

/** One model on disk: a spec, a config per run, a matrix and a mutations file. */
function writeModel(
	root: string,
	extra: { spec?: string; mutations?: unknown[]; checker?: Record<string, unknown>; matrix?: unknown[] } = {},
): string {
	const formal = path.join(root, "formal");
	// The `@code` tag of the spec points here.
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.writeFileSync(path.join(root, "src", "a.ts"), "// code\n".repeat(60));
	const tla = path.join(formal, "a", "tla");
	fs.mkdirSync(tla, { recursive: true });
	fs.writeFileSync(path.join(tla, "A.tla"), extra.spec ?? SPEC);
	fs.writeFileSync(path.join(tla, "MC.cfg"), "SPECIFICATION Spec\nINVARIANTS\n    P\n    Q\n");
	fs.writeFileSync(path.join(tla, "MC_live.cfg"), "SPECIFICATION Spec\nPROPERTY Live\n");
	fs.writeFileSync(path.join(tla, "MC_safe.cfg"), "SPECIFICATION Spec\nINVARIANT P\nPROPERTY NoBack\n");
	fs.writeFileSync(
		path.join(tla, "matrix.json"),
		JSON.stringify({
			runs: extra.matrix ?? [
				{ name: "all-invariants", config: "MC.cfg", expect: "pass" },
				{ name: "liveness", config: "MC_live.cfg", expect: "pass" },
				{ name: "safe-action-property", config: "MC_safe.cfg", expect: "pass" },
				{ name: "pinned-workers", config: "MC.cfg", expect: "pass", workers: "2" },
				{ name: "bug-mode", config: "MC.cfg", expect: "invariant", property: "P" },
				{ name: "deep-run", config: "MC.cfg", expect: "pass", tier: "deep", timeoutSec: 4800 },
			],
		}),
	);
	fs.writeFileSync(
		path.join(tla, "mutations.json"),
		JSON.stringify({
			checker: { kind: "tlc", config: "MC.cfg", workers: 4, timeoutSec: 900, ...extra.checker },
			mutations: extra.mutations ?? [
				{ name: "weaker-guard", search: "x < 2", replace: "x < 3", breaks: "P", isolate: true },
				{
					name: "live-one",
					search: "Live == <>(x = 2)",
					replace: "Live == <>(x = 9)",
					breaks: "Live",
					config: "MC_live.cfg",
				},
				{ name: "nothing-here", search: "no such text", replace: "x", breaks: "P" },
			],
		}),
	);
	fs.writeFileSync(
		path.join(formal, "manifest.json"),
		JSON.stringify({
			version: 1,
			models: [
				{
					id: "a",
					kind: "tla",
					dir: "a/tla",
					spec: "A.tla",
					matrix: "matrix.json",
					mutations: "mutations.json",
					covers: [],
				},
			],
		}),
	);
	return formal;
}

const flags = (...more: string[]) => parseArgs(["formal", "--tier", "fast", ...more]);

describe("the plan", () => {
	it("lists the matrix runs of the tier, the baselines and every mutation, with workers by property kind", async () => {
		const root = fs.mkdtempSync(path.join(temp, "plan-"));
		const formal = writeModel(root);
		const args = { ...flags(), dir: formal };
		const units = modelUnits(parseManifestOf(formal), formal, args);
		const planned = await planUnits([units], "tools");
		const byUnit = new Map(planned.map(unit => [unit.unit, unit]));
		expect(planned.map(unit => unit.unit)).toEqual([
			// a run that must pass first, longest limit first; then the baselines; then the mutations; the bug-mode run last
			"r0-all-invariants",
			"r1-liveness",
			"r2-safe-action-property",
			"r3-pinned-workers",
			"baseline",
			"base1",
			"m0-weaker-guard",
			"m1-live-one",
			"m2-nothing-here",
			"r4-bug-mode",
		]);
		// the fast tier leaves the deep run out
		expect(byUnit.has("r5-deep-run")).toBe(false);
		expect(byUnit.get("r0-all-invariants")).toMatchObject({ kind: "row", workers: "auto", timeoutSec: 600 });
		expect(byUnit.get("r1-liveness")?.workers).toBe("1");
		expect(byUnit.get("r2-safe-action-property")?.workers).toBe("auto");
		expect(byUnit.get("r3-pinned-workers")?.workers).toBe("2");
		expect(byUnit.get("r4-bug-mode")?.workers).toBe("1");
		expect(byUnit.get("baseline")).toMatchObject({ kind: "baseline", workers: "4", timeoutSec: 900 });
		// a liveness property runs on one worker, a safety property on the checker's
		expect(byUnit.get("base1")).toMatchObject({ kind: "config-baseline", workers: "1" });
		expect(byUnit.get("m0-weaker-guard")).toMatchObject({ kind: "mutation", workers: "4" });
		expect(byUnit.get("m1-live-one")?.workers).toBe("1");
		// every unit has a digest of its own input
		expect(new Set(planned.map(unit => unit.key)).size).toBe(planned.length);
	});

	it("keeps a unit's digest through a comment edit and changes it with the model, the config and the tools", async () => {
		const root = fs.mkdtempSync(path.join(temp, "plan-"));
		const formal = writeModel(root);
		const args = { ...flags(), dir: formal };
		const plan = async (tools = "tools") => planUnits([modelUnits(parseManifestOf(formal), formal, args)], tools);
		const keys = async (tools?: string) => Object.fromEntries((await plan(tools)).map(unit => [unit.unit, unit.key]));
		const before = await keys();
		const specFile = path.join(formal, "a", "tla", "A.tla");

		fs.writeFileSync(
			specFile,
			SPEC.replace("\\* @code src/a.ts:1-9 the step", "\\* @code src/a.ts:30-41 the step, moved"),
		);
		expect(await keys()).toEqual(before);

		fs.writeFileSync(specFile, SPEC.replace("Q == x \\in Nat", "Q == x \\in Int"));
		const edited = await keys();
		for (const id of Object.keys(before).filter(unit => unit !== "m2-nothing-here"))
			expect(edited[id], id).not.toBe(before[id]);

		fs.writeFileSync(specFile, SPEC);
		// (an invalid mutation reads no tool: its digest is its reason's)
		for (const [id, key] of Object.entries(await keys("another java")).filter(([unit]) => unit !== "m2-nothing-here"))
			expect(key, id).not.toBe(before[id]);

		fs.writeFileSync(
			path.join(formal, "a", "tla", "MC_live.cfg"),
			"SPECIFICATION Spec\nPROPERTY Live\nCHECK_DEADLOCK FALSE\n",
		);
		const config = await keys();
		expect(config["r1-liveness"]).not.toBe(before["r1-liveness"]);
		expect(config["base1"]).not.toBe(before["base1"]);
		expect(config["r0-all-invariants"]).toBe(before["r0-all-invariants"]);
	});

	it("gives a mutation the digest of the model it makes, and an invalid one a digest of its own", async () => {
		const root = fs.mkdtempSync(path.join(temp, "plan-"));
		const formal = writeModel(root, {
			mutations: [
				{ name: "one", search: "x < 2", replace: "x < 3", breaks: "P" },
				{ name: "same-model", search: "x < 2", replace: "x < 3", breaks: "Q" },
				{ name: "other", search: "x < 2", replace: "x < 4", breaks: "P" },
				{ name: "invalid", search: "no such text", replace: "x", breaks: "P" },
			],
		});
		const args = { ...flags(), dir: formal };
		const planned = await planUnits([modelUnits(parseManifestOf(formal), formal, args)], "tools");
		const key = (unit: string) => planned.find(item => item.unit === unit)?.key;
		expect(key("m0-one")).toBe(key("m1-same-model"));
		expect(key("m0-one")).not.toBe(key("m2-other"));
		expect(key("m3-invalid")).toMatch(/^[0-9a-f]{64}$/);
		expect(key("m3-invalid")).not.toBe(key("baseline"));
	});

	it("refuses a model that is not TLA+, and `--skip-mutations` plans the matrix alone", async () => {
		const root = fs.mkdtempSync(path.join(temp, "plan-"));
		const formal = writeModel(root);
		const manifest = parseManifestOf(formal);
		expect(() => modelUnits({ ...manifest, kind: "lean" }, formal, { ...flags(), dir: formal })).toThrow(
			/only TLA\+/,
		);
		const planned = await planUnits(
			[modelUnits(manifest, formal, { ...flags("--skip-mutations"), dir: formal })],
			"tools",
		);
		expect(planned.every(unit => unit.kind === "row")).toBe(true);
		const withoutMatrix = modelUnits({ ...manifest, matrix: undefined, configs: ["MC.cfg", "MC_live.cfg"] }, formal, {
			...flags("--skip-mutations"),
			dir: formal,
		});
		expect(withoutMatrix.rows.map(row => row.unit)).toEqual(["r0-MC.cfg", "r1-MC_live.cfg"]);
	});
});

function parseManifestOf(formal: string) {
	const raw = JSON.parse(fs.readFileSync(path.join(formal, "manifest.json"), "utf8"));
	return { ...raw.models[0], syncCommit: null };
}

/** The report verify-all prints from recorded verdicts: the same lines as a run, and a missing verdict is a failure. */
describe("verify-all --verdicts", () => {
	const tools = { tlaVersion: "1.8.0", javaMajor: 17, javaSource: "system" };
	const row = (
		unit: string,
		name: string,
		result: Pick<TlcResult, "outcome" | "property">,
		seconds = 1,
	): RowVerdict => ({
		version: VERDICT_VERSION,
		kind: "row",
		model: "a",
		unit,
		name,
		key: "k",
		cached: false,
		workers: "1",
		tools,
		run: {
			code: 0,
			result: { stats: { distinct: 10, generated: 20, depth: 3 }, trace: [], errors: [], warnings: [], ...result },
			text: "",
			configUsed: "MC.cfg",
			durationMs: seconds * 1000,
		},
	});
	const check = (kind: CheckVerdict["kind"], unit: string, name: string, result: UnitResult): CheckVerdict => ({
		version: VERDICT_VERSION,
		kind,
		model: "a",
		unit,
		name,
		key: "k",
		cached: false,
		workers: "1",
		tools,
		durationMs: 1,
		result,
	});
	const pass: CheckOutcome = { status: "pass", violated: [], detail: "no violation" };

	/** Runs verify-all on a model and returns its exit code and its report. */
	async function report(
		formal: string,
		verdicts: string,
		...more: string[]
	): Promise<{ code: number; lines: string[] }> {
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => void lines.push(parts.join(" ")));
		vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => void lines.push(parts.join(" ")));
		const code = await verifyAll([formal, "--tier", "fast", "--only", "a", "--verdicts", verdicts, ...more]);
		return { code, lines };
	}

	function writeAll(verdicts: string, skip: string[] = []): void {
		const all: (RowVerdict | CheckVerdict)[] = [
			row("r0-all-invariants", "all-invariants", { outcome: "pass" }),
			row("r1-liveness", "liveness", { outcome: "pass" }, 19.3),
			row("r2-safe-action-property", "safe-action-property", { outcome: "pass" }),
			row("r3-pinned-workers", "pinned-workers", { outcome: "pass" }),
			row("r4-bug-mode", "bug-mode", { outcome: "invariant", property: "P" }),
			check("baseline", "baseline", "baseline", { outcome: pass }),
			check("config-baseline", "base1", "baseline", { outcome: pass }),
			check("mutation", "m0-weaker-guard", "weaker-guard", {
				outcome: { status: "fail", violated: ["P"], detail: "invariant P" },
			}),
			check("mutation", "m1-live-one", "live-one", {
				outcome: { status: "fail", violated: ["Live"], detail: "temporal Live" },
			}),
			check("mutation", "m2-nothing-here", "nothing-here", {
				invalid: "the search text does not occur in the file",
			}),
		];
		for (const verdict of all) if (!skip.includes(verdict.unit)) writeVerdict(verdicts, verdict);
	}

	it("prints the matrix and the mutation report a run prints, from the verdicts", async () => {
		const root = fs.mkdtempSync(path.join(temp, "all-"));
		const formal = writeModel(root, {
			mutations: [
				{ name: "weaker-guard", search: "x < 2", replace: "x < 3", breaks: "P", isolate: true },
				{
					name: "live-one",
					search: "Live == <>(x = 2)",
					replace: "Live == <>(x = 9)",
					breaks: "Live",
					config: "MC_live.cfg",
				},
				{ name: "nothing-here", search: "no such text", replace: "x", breaks: "P" },
			],
			checker: {},
		});
		const verdicts = path.join(root, "verdicts");
		writeAll(verdicts);
		const { code, lines } = await report(formal, verdicts);
		const text = lines.join("\n");
		expect(text).toContain("TLC (tla2tools release 1.8.0)  java 17 (system)  spec A.tla");
		expect(text).toContain("ok    all-invariants: no violation  (10 distinct states, 20 generated, depth 3, 1.0s)");
		expect(text).toContain("ok    liveness: no violation  (10 distinct states, 20 generated, depth 3, 19.3s)");
		expect(text).toContain("ok    bug-mode: invariant P (as expected)");
		expect(text).toContain("PASS  matrix: all 5 runs ended as expected");
		expect(text).toContain("baseline: pass");
		expect(text).toContain("DETECTED weaker-guard: failed on P");
		expect(text).toContain("INVALID  nothing-here: the search text does not occur in the file");
		// an INVALID mutation is exit 2 of the mutation run, which verify-all reports as a failed check
		expect(code).toBe(1);
	});

	it("fails a run and a mutation whose verdict is missing", async () => {
		const root = fs.mkdtempSync(path.join(temp, "all-"));
		const formal = writeModel(root, {
			mutations: [
				{ name: "weaker-guard", search: "x < 2", replace: "x < 3", breaks: "P", isolate: true },
				{
					name: "live-one",
					search: "Live == <>(x = 2)",
					replace: "Live == <>(x = 9)",
					breaks: "Live",
					config: "MC_live.cfg",
				},
			],
		});
		const verdicts = path.join(root, "verdicts");
		writeAll(verdicts, ["r1-liveness", "m0-weaker-guard"]);
		const { code, lines } = await report(formal, verdicts);
		const text = lines.join("\n");
		expect(text).toContain("FAIL  liveness: expected pass, got error");
		expect(text).toContain("no verdict was recorded for this run: its job did not finish");
		expect(text).toContain("INVALID  weaker-guard: no verdict was recorded for this mutation");
		expect(code).toBe(1);
	});

	it("reports an unavailable tool as not checked, and a baseline that fails as a failure", async () => {
		const root = fs.mkdtempSync(path.join(temp, "all-"));
		const formal = writeModel(root, {
			mutations: [{ name: "weaker-guard", search: "x < 2", replace: "x < 3", breaks: "P", isolate: true }],
		});
		const verdicts = path.join(root, "verdicts");
		writeAll(verdicts, ["m1-live-one", "m2-nothing-here", "base1"]);
		writeVerdict(
			verdicts,
			check("baseline", "baseline", "baseline", {
				outcome: { status: "fail", violated: ["P"], detail: "invariant P" },
			}),
		);
		const failing = await report(formal, verdicts);
		expect(failing.lines.join("\n")).toContain("baseline: FAIL: invariant P");
		expect(failing.code).toBe(1);
		writeVerdict(
			verdicts,
			check("baseline", "baseline", "baseline", {
				outcome: { status: "unavailable", violated: [], detail: "TLC could not be prepared on this runner" },
			}),
		);
		expect((await report(formal, verdicts)).code).toBe(3);
	});
});
