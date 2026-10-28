/**
 * The dogfood run's fifteen gaps in ompdesk-formal-verify, one behavior at a time: findings per concern, the trace
 * rows that map to findings, the load check behind `--sany-only`, timeouts, `@code` through wrapper actions, mutation
 * verdicts, covers by function and line range, stamping and tiers. Real TLC runs are in `formal-gaps-real.test.ts`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	isolateProperties,
	parseCfg,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/cfg";
import {
	formatTag,
	indexDefinitions,
	tagsFor,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/code-tags";
import {
	findSymbolSpans,
	parseCover,
	parseHunks,
	rangeChanges,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/covers";
import {
	checkDrift,
	hasUncommitted,
	stampDigest,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/drift";
import {
	concernDocuments,
	normalizeFindings,
	toFindingsTrace,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/findings";
import {
	parseManifest,
	tierOf,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/manifest";
import {
	type Checker,
	mutationExitCode,
	parseMutations,
	runMutations,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/mutate-core";
import { validate } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/schema";
import {
	parseTlcOutput,
	reduceTrace,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/tlc-parse";
import {
	DEFAULT_TIMEOUT_SEC,
	timeoutMsFor,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/tlc";
import {
	type ModelResult,
	stampModels,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/verify-all";

const SKILL = path.join(__dirname, "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify");
const schema = JSON.parse(fs.readFileSync(path.join(SKILL, "assets/findings.schema.json"), "utf8"));
const example = JSON.parse(fs.readFileSync(path.join(SKILL, "assets/templates/findings.example.json"), "utf8"));
const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "formal-gaps-"));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

const bun = (script: string, args: string[], env: NodeJS.ProcessEnv = {}): { code: number | null; out: string } => {
	const run = spawnSync("bun", [path.join(SKILL, "scripts", script), ...args], {
		encoding: "utf8",
		env: { ...process.env, OMPDESK_FORMAL_CACHE: path.join(temp, "cache"), ...env },
	});
	return { code: run.status, out: run.stdout + run.stderr };
};

describe("gap 1: findings per concern, reports in formal/reports/", () => {
	const formal = path.join(temp, "repo1/formal");
	const concern = (name: string): unknown => ({ ...example, concern: name });
	fs.mkdirSync(formal, { recursive: true });
	fs.writeFileSync(path.join(formal, "manifest.json"), "{}");
	fs.mkdirSync(path.join(formal, "turn-resume"), { recursive: true });
	fs.writeFileSync(path.join(formal, "findings.turn-resume.json"), JSON.stringify(concern("turn-resume")));
	fs.writeFileSync(path.join(formal, "findings.session-listing.json"), JSON.stringify(concern("session-listing")));
	fs.writeFileSync(path.join(formal, "turn-resume/findings.json"), JSON.stringify(concern("nested")));

	it("writes one page per concern into formal/reports/ for several files", () => {
		const run = bun("report.ts", [
			path.join(formal, "findings.turn-resume.json"),
			path.join(formal, "findings.session-listing.json"),
		]);
		expect(run.code).toBe(0);
		expect(fs.existsSync(path.join(formal, "reports/turn-resume.html"))).toBe(true);
		expect(fs.existsSync(path.join(formal, "reports/session-listing.html"))).toBe(true);
	});

	it("takes a folder: findings.json, findings.<concern>.json and <subfolder>/findings.json", () => {
		fs.rmSync(path.join(formal, "reports"), { recursive: true, force: true });
		const run = bun("report.ts", [formal]);
		expect(run.code).toBe(0);
		expect(fs.readdirSync(path.join(formal, "reports")).sort()).toEqual([
			"nested.html",
			"session-listing.html",
			"turn-resume.html",
		]);
	});

	it("takes one file holding several concerns, and reports bad ones with their index", () => {
		const file = path.join(formal, "all.json");
		fs.writeFileSync(file, JSON.stringify({ concerns: [concern("a-one"), concern("b-two")] }));
		expect(bun("report.ts", [file, "--out-dir", path.join(temp, "out1")]).code).toBe(0);
		expect(fs.readdirSync(path.join(temp, "out1")).sort()).toEqual(["a-one.html", "b-two.html"]);
		expect(concernDocuments({ concerns: [1, 2] })).toHaveLength(2);
		fs.writeFileSync(file, JSON.stringify({ concerns: [concern("ok"), { concern: "bad" }] }));
		const bad = bun("report.ts", [file]);
		expect(bad.code).toBe(2);
		expect(bad.out).toContain("concerns[1]");
	});

	it("refuses --out for several pages and two documents of one concern", () => {
		const both = [path.join(formal, "findings.turn-resume.json"), path.join(formal, "findings.session-listing.json")];
		expect(bun("report.ts", [...both, "--out", path.join(temp, "x.html")]).code).toBe(2);
		const dup = path.join(formal, "findings.dup.json");
		fs.writeFileSync(dup, JSON.stringify(concern("turn-resume")));
		const clash = bun("report.ts", [dup, both[0] as string]);
		expect(clash.code).toBe(2);
		expect(clash.out).toContain("both concern");
		fs.rmSync(dup);
	});
});

describe("gap 2: tlc.ts trace rows are findings trace[] rows", () => {
	const result = parseTlcOutput(fixture("tlc-invariant.txt"), 12);
	const rows = reduceTrace(result.trace, {
		definitions: () => indexDefinitions(fixture("JobLease.tla")),
		outcome: result.outcome,
	});
	const rowSchema = schema.properties.findings.items.properties.trace.items;

	it("converts to the schema's row shape", () => {
		const trace = toFindingsTrace(rows);
		expect(trace.length).toBe(rows.length);
		for (const row of trace) expect(validate(row, rowSchema)).toEqual([]);
		expect(trace[0]).toMatchObject({ step: 1, action: "Init" });
		expect(trace.at(-1)?.violation).toBe(true);
		const changed = trace.find(
			row => row.changed && Object.values(row.changed).some(value => value.includes(" -> ")),
		);
		expect(changed).toBeDefined();
	});

	it("a finding pasted with raw tlc.ts rows validates once report.ts normalizes it", () => {
		const doc = { ...example, findings: [{ ...example.findings[0], trace: rows }] };
		expect(validate(doc, schema).length).toBeGreaterThan(0);
		expect(validate(normalizeFindings(doc), schema)).toEqual([]);
	});

	it("the rows tlc.ts --json writes are trace[] already (checked on the real run in formal-gaps-real)", () => {
		const raw = JSON.stringify({ trace: toFindingsTrace(rows), rows });
		expect(
			validate({ ...example, findings: [{ ...example.findings[0], trace: JSON.parse(raw).trace }] }, schema),
		).toEqual([]);
	});
});

describe("gap 3: a spec TLC rejects is not a PASS", () => {
	it("names the missing operator when TLC stops while loading the modules", () => {
		const text = [
			"TLC2 Version 2026.10.28.014557 (rev: 56d37a9)",
			"line 4, col 13 to line 4, col 14 of module T3",
			"",
			"Could not find declaration or definition of symbol '-.'.",
			"",
			"Starting... (2026-10-28 18:13:47)",
			"Error: Parsing or semantic analysis failed.",
		].join("\n");
		const result = parseTlcOutput(text, 255);
		expect(result.outcome).toBe("parse-error");
		expect(result.message).toBe("Could not find declaration or definition of symbol '-.'.");
	});

	it("tla-pitfalls and tlc-cli document the SANY gap and what --sany-only does about it", () => {
		const pitfalls = fs.readFileSync(path.join(SKILL, "references/tla-pitfalls.md"), "utf8");
		expect(pitfalls).toContain("EXTENDS Integers");
		expect(pitfalls).toContain("--sany-only");
	});
});

describe("gap 4: pitfalls", () => {
	it("lists the CHOOSE and the multi-line IF pitfalls", () => {
		const pitfalls = fs.readFileSync(path.join(SKILL, "references/tla-pitfalls.md"), "utf8");
		expect(pitfalls).toContain("CHOOSE x \\in S : TRUE /\\ y");
		expect(pitfalls).toContain("not completely specified");
	});
});

describe("gap 5: timeouts and liveness guidance", () => {
	it("runs without --timeout for at most ten minutes, and 0 means no limit", () => {
		expect(DEFAULT_TIMEOUT_SEC).toBe(600);
		expect(timeoutMsFor(undefined)).toBe(600_000);
		expect(timeoutMsFor(30)).toBe(30_000);
		expect(timeoutMsFor(0)).toBeUndefined();
		expect(bun("tlc.ts", ["x.tla", "--timeout", "-1"]).code).toBe(2);
	});

	it("documents component-wise fairness", () => {
		const text = fs.readFileSync(path.join(SKILL, "references/tla-pitfalls.md"), "utf8");
		expect(text).toContain("component");
		expect(text).toContain("236");
	});
});

describe("gap 6: @code through a wrapper action", () => {
	const spec = [
		"---- MODULE W ----",
		"\\* @code a.ts:1-2 do it",
		"Step(p) == x' = p",
		"\\* @code a.ts:3 other",
		"Other(n) == x' = n",
		"Pairs == {<<1,1>>}",
		"ResumeStep ==",
		"  \\E p \\in Pairs :",
		"    /\\ p[1] > 0",
		"    /\\ Step(p)",
		"Untagged == Pairs = {}",
		"Wrap2 == ResumeStep",
		"====",
	].join("\n");
	const defs = indexDefinitions(spec);

	it("falls back to the tagged actions the named wrapper calls", () => {
		expect(tagsFor(defs, "ResumeStep", 7).map(formatTag)).toEqual(["a.ts:1-2"]);
		expect(tagsFor(defs, "Wrap2", undefined).map(formatTag)).toEqual(["a.ts:1-2"]);
	});

	it("gives nothing for a definition that calls no tagged action", () => {
		expect(tagsFor(defs, "Untagged", 11)).toEqual([]);
	});

	it("the wrapper's own tag wins over its callees", () => {
		const tagged = spec.replace("ResumeStep ==", "\\* @code b.ts:9 resume\nResumeStep ==");
		expect(tagsFor(indexDefinitions(tagged), "ResumeStep", undefined).map(formatTag)).toEqual(["b.ts:9"]);
	});
});

describe("gap 8: mutations", () => {
	const make = (spec: unknown[], extra: Record<string, unknown> = {}) =>
		parseMutations({
			checker: { kind: "command", command: ["x"] },
			properties: ["PropA", "PropB"],
			mutations: spec,
			...extra,
		});
	const checker: Checker = async (_dir, model) => {
		const text = fs.readFileSync(model, "utf8");
		const missing = ["A", "B"].filter(name => !text.includes(`guard ${name}`));
		if (text.includes("deadlock")) return { status: "fail", violated: ["deadlock"], detail: "deadlock" };
		return missing.length
			? { status: "fail", violated: missing.map(name => `Prop${name}`), detail: "x" }
			: { status: "pass", violated: [], detail: "ok" };
	};
	const folder = (): { root: string; model: string } => {
		const root = fs.mkdtempSync(path.join(temp, "mut-"));
		const model = path.join(root, "model.txt");
		fs.writeFileSync(model, "guard A\nguard B\nnote: a comment\n");
		return { root, model };
	};

	it("records an equivalent mutant with its reason and does not fail the run", async () => {
		const { root, model } = folder();
		const spec = make(
			[
				{ name: "drop-a", search: "guard A\n", replace: "", breaks: "PropA" },
				{ name: "drop-b", search: "guard B\n", replace: "", breaks: "PropB" },
				{ name: "reword", search: "a comment", replace: "another comment", equivalent: "the line is a comment" },
			],
			{},
		);
		const report = await runMutations({ root, model, spec, properties: ["PropA", "PropB"], check: checker });
		const equivalent = report.results.find(result => result.name === "reword");
		expect(equivalent?.status).toBe("EQUIVALENT");
		expect(equivalent?.detail).toContain("the line is a comment");
		expect(report.properties.every(property => property.status === "covered")).toBe(true);
		expect(mutationExitCode(report)).toBe(0);
	});

	it("flags a wrong equivalence claim: the mutant is detected after all", async () => {
		const { root, model } = folder();
		const spec = make([
			{ name: "drop-a", search: "guard A\n", replace: "", breaks: "PropA" },
			{ name: "claimed", search: "guard B\n", replace: "", equivalent: "no, it is not" },
		]);
		const report = await runMutations({ root, model, spec, properties: ["PropA"], check: checker });
		expect(report.results.find(result => result.name === "claimed")?.status).toBe("INVALID");
		expect(mutationExitCode(report)).toBe(2);
	});

	it("an equivalent mutant does not cover a property", async () => {
		const { root, model } = folder();
		const spec = make([
			{ name: "reword", search: "a comment", replace: "b", equivalent: "comment", breaks: "PropA" },
		]);
		const report = await runMutations({ root, model, spec, properties: ["PropA"], check: checker });
		expect(report.properties[0]?.status).toBe("UNCOVERED");
	});

	it("rejects an empty equivalent reason", () => {
		expect(() => make([{ name: "x", search: "a", replace: "b", equivalent: " " }])).toThrow(/equivalent/);
	});

	it("says when a mutation deadlocked the model before the property could fail, and how to fix it", async () => {
		const { root, model } = folder();
		const spec = make([{ name: "dead", search: "note", replace: "deadlock", breaks: "PropA" }]);
		const report = await runMutations({ root, model, spec, properties: ["PropA"], check: checker });
		expect(report.results[0]?.status).toBe("MISSED");
		expect(report.results[0]?.detail).toContain('"deadlock": false');
	});

	it("parses deadlock and isolate on a mutation and deadlock on the tlc checker", () => {
		const spec = parseMutations({
			checker: { kind: "tlc", config: "MC.cfg", deadlock: false },
			mutations: [{ name: "m", search: "a", replace: "b", breaks: "P", deadlock: false, isolate: true }],
		});
		expect(spec.checker).toMatchObject({ kind: "tlc", deadlock: false });
		expect(spec.mutations[0]).toMatchObject({ deadlock: false, isolate: true });
		expect(() =>
			parseMutations({
				checker: { kind: "tlc" },
				mutations: [{ name: "m", search: "a", replace: "b", breaks: "P", isolate: "yes" }],
			}),
		).toThrow(/isolate/);
	});

	it("derives a single-property config from the base config", () => {
		const base = [
			"\\* a comment",
			"SPECIFICATION Spec",
			"CONSTANTS",
			"    N = 2",
			"INVARIANTS",
			"    TypeOK",
			"    Safe",
			"    Other",
			"PROPERTIES",
			"    Live",
			"CHECK_DEADLOCK FALSE",
		].join("\n");
		const derived = parseCfg(isolateProperties(base, ["Safe"]));
		expect(derived.invariants).toEqual(["Safe"]);
		expect(derived.properties).toEqual([]);
		expect(derived.constants).toEqual({ N: "2" });
		expect(derived.checkDeadlock).toBe(false);
		expect(isolateProperties(base, ["Live"])).not.toContain("INVARIANT");
		expect(parseCfg(isolateProperties("INVARIANT A B C", ["B", "C"])).invariants).toEqual(["B", "C"]);
	});
});

describe("gap 12: covers by function and line range, and the drift line (gap 14)", () => {
	const repo = path.join(temp, "repo12");
	const git = (...args: string[]): string =>
		spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
			cwd: repo,
			encoding: "utf8",
		}).stdout.trim();
	const SOURCE = [
		"import x from 'x';", // 1
		"", // 2
		"export function sync(a: number) {", // 3
		"	const s = `x ${a} {`;", // 4
		"	if (a > 1) {", // 5
		"		return s;", // 6
		"	}", // 7
		"	return 'done'; // }", // 8
		"}", // 9
		"", // 10
		"export class Pool {", // 11
		"	sync(b: string): void {", // 12
		"		this.run(b);", // 13
		"	}", // 14
		"	run(b: string) {", // 15
		"		return b;", // 16
		"	}", // 17
		"}", // 18
		"", // 19
		"export const other = (n: number) => n + 1;", // 20
		"",
	].join("\n");
	let first = "";
	const write = (text: string): void => fs.writeFileSync(path.join(repo, "src/a.ts"), text);

	it("parses the three kinds of covers entry", () => {
		expect(parseCover("src/a.ts")).toMatchObject({ kind: "path" });
		expect(parseCover("src/a.ts#Pool.sync")).toMatchObject({ kind: "symbol", symbol: "Pool.sync" });
		expect(parseCover("src/a.ts:12-40")).toMatchObject({ kind: "range", start: 12, end: 40 });
		expect(parseCover("src/a.ts:7")).toMatchObject({ kind: "range", start: 7, end: 7 });
		expect(() => parseCover("src/a.ts:9-3")).toThrow(/range/);
		expect(() =>
			parseManifest({
				version: 1,
				models: [{ id: "a", kind: "tla", dir: "d", spec: "A.tla", covers: ["../x.ts#f"] }],
			}),
		).toThrow(/without \.\./);
	});

	it("finds a function, a method and a const by name, skipping braces in strings and comments", () => {
		expect(findSymbolSpans(SOURCE, "sync")).toEqual([
			{ start: 3, end: 9 },
			{ start: 12, end: 14 },
		]);
		expect(findSymbolSpans(SOURCE, "Pool.sync")).toEqual([{ start: 12, end: 14 }]);
		expect(findSymbolSpans(SOURCE, "Pool.run")).toEqual([{ start: 15, end: 17 }]);
		expect(findSymbolSpans(SOURCE, "other")).toEqual([{ start: 20, end: 20 }]);
		expect(findSymbolSpans(SOURCE, "missing")).toEqual([]);
		expect(findSymbolSpans("def f(x):\n    return x\n\ndef g():\n    pass\n", "f")).toEqual([{ start: 1, end: 2 }]);
	});

	it("counts hunks that touch a range, and notices lines that moved above it", () => {
		const hunks = parseHunks("@@ -3,0 +4,2 @@\n+a\n+b\n@@ -20 +22 @@\n-x\n+y\n");
		expect(rangeChanges(hunks, 30, 40)).toEqual({ touched: false, shifted: 2 });
		expect(rangeChanges(hunks, 22, 22)).toEqual({ touched: true, shifted: 2 });
		expect(rangeChanges(parseHunks("@@ -10,2 +9,0 @@\n-a\n-b\n"), 5, 20)).toEqual({ touched: true, shifted: 0 });
	});

	it("an edit outside the covered function is not drift; an edit inside it is", async () => {
		fs.mkdirSync(path.join(repo, "src"), { recursive: true });
		write(SOURCE);
		git("init", "-q");
		git("add", "-A");
		git("commit", "-q", "-m", "first");
		first = git("rev-parse", "HEAD");
		const covers = ["src/a.ts#sync", "src/a.ts:12-14"];
		expect((await checkDrift(repo, covers, first)).status).toBe("ok");
		write(SOURCE.replace("(n: number) => n + 1", "(n: number) => n + 2"));
		expect((await checkDrift(repo, ["src/a.ts#Pool.sync"], first)).status).toBe("ok");
		expect((await checkDrift(repo, ["src/a.ts"], first)).status).toBe("drift");
		expect(await hasUncommitted(repo, ["src/a.ts#sync"])).toBe(false);
		expect(await hasUncommitted(repo, ["src/a.ts#other"])).toBe(true);
		write(SOURCE.replace("return 'done';", "return 'later';"));
		const drift = await checkDrift(repo, ["src/a.ts#sync", "src/a.ts#Pool.run"], first);
		expect(drift.status).toBe("drift");
		expect(drift.files).toEqual(["src/a.ts#sync"]);
	});

	it("a line range notices an edit inside it, and lines inserted above it", async () => {
		write(SOURCE.replace("		this.run(b);", "		this.run(b.trim());"));
		const inside = await checkDrift(repo, ["src/a.ts:12-14"], first);
		expect(inside).toMatchObject({ status: "drift", files: ["src/a.ts:12-14"] });
		write(SOURCE.replace("import x from 'x';", "import x from 'x';\nimport y from 'y';"));
		const moved = await checkDrift(repo, ["src/a.ts:12-14"], first);
		expect(moved.status).toBe("drift");
		expect(moved.files[0]).toContain("lines moved by +1");
		expect((await checkDrift(repo, ["src/a.ts:2-2"], first)).status).toBe("drift");
	});

	it("names a missing function as an error instead of reporting no drift", async () => {
		write(SOURCE);
		const missing = await checkDrift(repo, ["src/a.ts#nope"], first);
		expect(missing.status).toBe("git-error");
		expect(missing.message).toContain("nope");
	});

	it("a function that was renamed or removed is drift", async () => {
		write(SOURCE.replace("export function sync(", "export function sync2("));
		const gone = await checkDrift(repo, ["src/a.ts#sync"], first);
		expect(gone.status).toBe("drift");
		write(SOURCE);
	});

	it("gap 11: stamping HEAD refuses uncommitted covered code, --allow-dirty stamps it with a digest", async () => {
		const formal = path.join(repo, "formal");
		fs.mkdirSync(formal, { recursive: true });
		const manifest = path.join(formal, "manifest.json");
		const entry = { id: "m", kind: "tla", dir: "m", spec: "M.tla", covers: ["src/a.ts#sync"], syncCommit: null };
		fs.writeFileSync(manifest, JSON.stringify({ version: 1, models: [entry] }));
		const models = parseManifest(JSON.parse(fs.readFileSync(manifest, "utf8"))).models;
		const results: ModelResult[] = [{ id: "m", checks: [{ name: "TLC matrix", verdict: "pass" }] }];
		const head = git("rev-parse", "HEAD");
		// The model files do not exist at HEAD (formal/ is untracked) and that is fine: only the covered code counts.
		await stampModels(repo, manifest, models, results, false);
		expect(JSON.parse(fs.readFileSync(manifest, "utf8")).models[0]).toMatchObject({ syncCommit: head });
		expect(JSON.parse(fs.readFileSync(manifest, "utf8")).models[0].syncDiff).toBeUndefined();

		write(SOURCE.replace("return 'done';", "return 'edited';"));
		fs.writeFileSync(manifest, JSON.stringify({ version: 1, models: [entry] }));
		await stampModels(repo, manifest, models, results, false);
		expect(JSON.parse(fs.readFileSync(manifest, "utf8")).models[0].syncCommit).toBeNull();
		await stampModels(repo, manifest, models, results, true);
		const stamped = JSON.parse(fs.readFileSync(manifest, "utf8")).models[0];
		expect(stamped.syncCommit).toBe(head);
		expect(stamped.syncDiff).toBe(await stampDigest(repo, ["src/a.ts#sync"], head));
		expect(parseManifest(JSON.parse(fs.readFileSync(manifest, "utf8"))).models[0]?.syncDiff).toBe(stamped.syncDiff);

		// In sync while the covered code stays as stamped, committed or not; drift once it changes again.
		expect((await checkDrift(repo, ["src/a.ts#sync"], head, stamped.syncDiff)).status).toBe("ok");
		git("commit", "-q", "-am", "commit the stamped change");
		expect((await checkDrift(repo, ["src/a.ts#sync"], head, stamped.syncDiff)).status).toBe("ok");
		write(SOURCE.replace("return 'done';", "return 'again';"));
		const changed = await checkDrift(repo, ["src/a.ts#sync"], head, stamped.syncDiff);
		expect(changed.status).toBe("drift");
		expect(changed.message).toContain("what was stamped");
		write(SOURCE);
		git("checkout", "-q", "--", "src/a.ts");
	});

	it("gap 14: a drift that does not fail the run is printed as DRIFT, never as ok", () => {
		const src = fs.readFileSync(path.join(SKILL, "scripts/verify-all.ts"), "utf8");
		expect(src).toContain('verdict === "drift" ? "DRIFT"');
		expect(src).toContain('"drift" : "fail"');
	});
});

describe("gap 15: tiers and the TLC version", () => {
	const model = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
		id,
		kind: "tla",
		dir: "m",
		spec: "M.tla",
		...extra,
	});

	it("a model's tier is its manifest tier, deep for an id ending in -deep, else fast", () => {
		const parsed = parseManifest({
			version: 1,
			models: [model("a"), model("a-deep"), model("b", { tier: "deep" }), model("c-deep", { tier: "fast" })],
		});
		expect(parsed.models.map(tierOf)).toEqual(["fast", "deep", "deep", "fast"]);
		expect(() => parseManifest({ version: 1, models: [model("a", { tier: "slow" })] })).toThrow(/tier/);
	});

	it("verify-all --tier fast (the default) skips deep models, --tier deep runs every model", () => {
		const dir = path.join(temp, "tiers");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "manifest.json"),
			JSON.stringify({ version: 1, models: [model("quick"), model("slow", { tier: "deep" })] }),
		);
		const fast = bun("verify-all.ts", [dir, "--skip-mutations"]);
		expect(fast.out).toMatch(/tier fast: quick\b.*not run: slow \[deep\]/);
		expect(fast.out).toContain("== quick");
		expect(fast.out).not.toContain("== slow");
		const deep = bun("verify-all.ts", [dir, "--tier", "deep", "--skip-mutations"]);
		expect(deep.out).toContain("== quick");
		expect(deep.out).toContain("== slow");
		const only = bun("verify-all.ts", [dir, "--only", "slow", "--skip-mutations"]);
		expect(only.out).toContain("== slow");
		expect(bun("verify-all.ts", [dir, "--tier", "all"]).code).toBe(2);
		expect(bun("verify-all.ts", [dir, "--allow-dirty"]).code).toBe(2);
	});

	it("reads the version TLC prints, which is not the release tag the jar is pinned by", () => {
		const banner = "TLC2 Version 2026.10.28.014557 (rev: 56d37a9)\n";
		const result = parseTlcOutput(banner + fixture("tlc-pass.txt"), 0);
		expect(result.tlcVersion).toBe("2026.10.28.014557");
		expect(parseTlcOutput("nothing", 0).tlcVersion).toBeUndefined();
	});
});
