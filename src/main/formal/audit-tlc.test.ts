/**
 * The TLC-path audit findings (numbers follow the audit): each case fails on the code it was written against.
 * Pure cases run always; cases that start the real TLC run with `OMP_GUI_REAL_FORMAL=1` and
 * `OMPDESK_FORMAL_CACHE=<cache with TLC installed>`.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	isolateProperties,
	overrideConstants,
	parseCfg,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/cfg";
import {
	extractTags,
	formatTag,
	indexDefinitions,
	tagsFor,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/code-tags";
import { judge } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/matrix";
import {
	applyMutation,
	type Checker,
	parseMutations,
	runMutations,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/mutate-core";
import {
	defaultJobs,
	poolPromises,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/pool";
import { removeTree } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/scratch";
import { parseTlcOutput } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/tlc-parse";

const SKILL = path.join(__dirname, "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify");
const REAL = process.env.OMP_GUI_REAL_FORMAL === "1";
const CACHE = process.env.OMPDESK_FORMAL_CACHE ?? path.join(os.tmpdir(), "formal-cache");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "formal-audit-tlc-"));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

interface Ran {
	code: number | null;
	out: string;
}

function bun(script: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Ran> {
	const { promise, resolve } = Promise.withResolvers<Ran>();
	execFile(
		"bun",
		[path.join(SKILL, "scripts", script), ...args],
		{ encoding: "utf8", env: { ...process.env, OMPDESK_FORMAL_CACHE: CACHE, ...env }, maxBuffer: 64 * 1024 * 1024 },
		(error, stdout, stderr) =>
			resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out: `${stdout}${stderr}` }),
	);
	return promise;
}

let counter = 0;
/** A model folder: `Name.tla`, `Name.cfg` and any extra files; returns the spec path. */
function model(name: string, tla: string, cfg: string, extra: Record<string, string> = {}): string {
	const dir = path.join(temp, `${name}-${counter++}`);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.tla`), tla);
	fs.writeFileSync(path.join(dir, `${name}.cfg`), cfg);
	for (const [file, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, file), text);
	return path.join(dir, `${name}.tla`);
}

const COUNTER = (invariant: string): string =>
	`---- MODULE Cnt ----\nEXTENDS Naturals\nVARIABLES x\nInit == x = 0\nNext == x < 3 /\\ x' = x + 1\nSpec == Init /\\ [][Next]_x\nInv == ${invariant}\n====\n`;

describe("1: TLC's soundness warnings are not hidden and a PASS under them is not a pass", () => {
	const STATE_LEVEL =
		"Warning: The formula Small is a state-level formula, but it was used as a PROPERTY (or PROPERTIES), where a temporal formula is typically expected. State-level formulas used as PROPERTY or PROPERTIES are only checked in the initial state. To verify that the formula Small holds in all states of every behavior, use INVARIANT Small instead.";
	const SYMMETRY =
		"Warning: Declaring symmetry during liveness checking is dangerous. It might cause TLC to miss violations of the stated liveness properties. Please check liveness without symmetry defined.";
	const PASS =
		"Model checking completed. No error has been found.\n4 states generated, 4 distinct states found, 0 states left on queue.";

	it("a state-level PROPERTY that TLC only checked in the initial state is `unsound`, with the warning kept", () => {
		const result = parseTlcOutput(`Starting...\n${STATE_LEVEL}\n${PASS}\n`, 0);
		expect(result.outcome).toBe("unsound");
		expect(result.message).toContain("only checked in the initial state");
		expect(result.warnings).toHaveLength(1);
	});

	it("SYMMETRY with a liveness property is `unsound` too", () => {
		const result = parseTlcOutput(`Starting...\n${SYMMETRY}\n${PASS}\n`, 0);
		expect(result.outcome).toBe("unsound");
		expect(result.message).toContain("symmetry during liveness checking is dangerous");
	});

	it("another warning leaves a pass a pass, and a real violation stays the violation", () => {
		expect(parseTlcOutput(`Warning: something harmless\n${PASS}\n`, 0).outcome).toBe("pass");
		const lasso = parseTlcOutput(
			`${SYMMETRY}\nError: Temporal property Live was violated.\nError: The following behavior constitutes a counter-example:\nState 1: <Initial predicate>\nx = 0\n\nState 2: Stuttering\n`,
			13,
		);
		expect(lasso.outcome).toBe("temporal");
	});

	it("a matrix run that expects pass does not accept it", () => {
		const unsound = parseTlcOutput(`${SYMMETRY}\n${PASS}\n`, 0);
		expect(judge({ expect: "pass" }, unsound).ok).toBe(false);
		expect(judge({ expect: "violation" }, unsound).ok).toBe(false);
	});

	it.skipIf(!REAL)(
		"tlc.ts fails a state-level PROPERTY and says why; --json carries the warnings",
		async () => {
			const spec = model(
				"Small",
				"---- MODULE Small ----\nEXTENDS Naturals\nVARIABLES x\nInit == x = 0\nNext == x < 3 /\\ x' = x + 1\nSpec == Init /\\ [][Next]_x\nSmall == x < 2\n====\n",
				"SPECIFICATION Spec\nPROPERTY Small\nCHECK_DEADLOCK FALSE\n",
			);
			const json = path.join(temp, "small.json");
			const run = await bun("tlc.ts", [spec, "--json", json]);
			expect(run.code).toBe(1);
			expect(run.out).toMatch(/^FAIL/m);
			expect(run.out).toContain("only checked in the initial state");
			const report = JSON.parse(fs.readFileSync(json, "utf8"));
			expect(report.outcome).toBe("unsound");
			expect(report.warnings.join(" ")).toContain("state-level formula");
		},
		90_000,
	);
});

describe("2: --sany-only fails on a semantic error", () => {
	it.skipIf(!REAL)(
		"`-1` without EXTENDS Integers fails at SANY (exit 2) and names the symbol",
		async () => {
			const spec = model(
				"Neg",
				"---- MODULE Neg ----\nEXTENDS Naturals\nVARIABLES x\nInit == x = -1\nNext == x' = x\nSpec == Init /\\ [][Next]_x\n====\n",
				"SPECIFICATION Spec\n",
			);
			const run = await bun("tlc.ts", [spec, "--sany-only"]);
			expect(run.code).toBe(2);
			expect(run.out).toMatch(/^FAIL {2}SANY found errors/m);
			expect(run.out).toContain("'-.'");
			expect(run.out).not.toMatch(/^PASS/m);
		},
		90_000,
	);

	it.skipIf(!REAL)(
		"an undefined symbol fails without a config as well",
		async () => {
			const spec = model(
				"Und",
				"---- MODULE Und ----\nEXTENDS Naturals\nVARIABLES x\nInit == x = Foo\n====\n",
				"SPECIFICATION Spec\n",
			);
			fs.rmSync(spec.replace(/\.tla$/, ".cfg"));
			const run = await bun("tlc.ts", [spec, "--sany-only"]);
			expect(run.code).toBe(2);
			expect(run.out).toContain("Foo");
		},
		90_000,
	);

	it("tla-pitfalls, tlc-cli and tlc.ts no longer claim SANY misses an unresolved operator", () => {
		const read = (file: string): string => fs.readFileSync(path.join(SKILL, file), "utf8");
		for (const text of [read("references/tla-pitfalls.md"), read("references/tlc-cli.md"), read("scripts/tlc.ts")]) {
			expect(text).not.toMatch(
				/SANY (?:alone )?(?:does not|doesn't|misses|accepts|passes)[^.\n]*(?:-1|unresolved|EXTEND)/i,
			);
		}
		expect(read("scripts/lib/tlc-run.ts")).toContain("-error-codes");
	});
});

describe("3: a config's baseline is keyed by config, isolation and deadlock", () => {
	const MODEL = "guard A\nguard B\n";
	function folder(): { root: string; file: string } {
		const root = fs.mkdtempSync(path.join(temp, "b-"));
		const file = path.join(root, "model.txt");
		fs.writeFileSync(file, MODEL);
		return { root, file };
	}
	/** Fails an unmutated model under an isolated config for Q, or with deadlock checking on under X.cfg. */
	const check: Checker = async (_dir, file, mutation) => {
		const text = fs.readFileSync(file, "utf8");
		if (text.includes("MUTATED")) {
			return { status: "fail", violated: [mutation?.breaks[0] as string], detail: "violated" };
		}
		if (mutation?.isolate && mutation.breaks.includes("Q"))
			return { status: "fail", violated: ["Q"], detail: "fails on its own" };
		if (mutation?.config === "X.cfg" && mutation.deadlock === undefined && mutation.breaks.includes("R"))
			return { status: "fail", violated: ["deadlock"], detail: "deadlocks on its own" };
		return { status: "pass", violated: [], detail: "ok" };
	};

	it("does not reuse the first mutation's isolated baseline for a mutation that isolates another property", async () => {
		const { root, file } = folder();
		const spec = parseMutations({
			checker: { kind: "command", command: ["unused"] },
			properties: ["P", "Q"],
			mutations: [
				{ name: "m-p", search: "guard A", replace: "MUTATED", breaks: "P", config: "X.cfg", isolate: true },
				{ name: "m-q", search: "guard B", replace: "MUTATED", breaks: "Q", config: "X.cfg", isolate: true },
			],
		});
		const report = await runMutations({ root, model: file, spec, properties: ["P", "Q"], check });
		const byName = Object.fromEntries(report.results.map(result => [result.name, result]));
		expect(byName["m-p"]?.status).toBe("DETECTED");
		expect(byName["m-q"]?.status).toBe("INVALID");
		expect(byName["m-q"]?.detail).toContain("does not pass under X.cfg");
	});

	it("does not reuse a baseline taken with deadlock checking off for a mutation that checks deadlock", async () => {
		const { root, file } = folder();
		const spec = parseMutations({
			checker: { kind: "command", command: ["unused"] },
			properties: ["P", "R"],
			mutations: [
				{ name: "m-p", search: "guard A", replace: "MUTATED", breaks: "P", config: "X.cfg", deadlock: false },
				{ name: "m-r", search: "guard B", replace: "MUTATED", breaks: "R", config: "X.cfg" },
			],
		});
		const report = await runMutations({ root, model: file, spec, properties: ["P", "R"], check });
		const byName = Object.fromEntries(report.results.map(result => [result.name, result]));
		expect(byName["m-p"]?.status).toBe("DETECTED");
		expect(byName["m-r"]?.status).toBe("INVALID");
	});
});

describe("4: an invariant violated by the initial state", () => {
	const TEXT = [
		"TLC2 Version 2026.10.28.014557 (rev: 56d37a9)",
		"Starting... (2026-10-28 23:20:26)",
		"Computing initial states...",
		"Error: Invariant Inv is violated by the initial state:",
		"/\\ x = 0",
		"/\\ y = 7",
		"",
		"Finished in 00s at (2026-10-28 23:20:26)",
	].join("\n");

	it("is an invariant violation of Inv with a one-state trace", () => {
		const result = parseTlcOutput(TEXT, 12);
		expect(result.outcome).toBe("invariant");
		expect(result.property).toBe("Inv");
		expect(result.trace).toHaveLength(1);
		expect(result.trace[0]).toMatchObject({ index: 1, kind: "initial", vars: { x: "0", y: "7" } });
		expect(judge({ expect: "invariant", property: "Inv" }, result).ok).toBe(true);
	});

	it("is explained from a saved log too", () => {
		const log = path.join(temp, "init.log");
		fs.writeFileSync(log, TEXT);
		const result = parseTlcOutput(fs.readFileSync(log, "utf8"));
		expect(result.outcome).toBe("invariant");
		expect(result.property).toBe("Inv");
	});

	it.skipIf(!REAL)(
		"tlc.ts --matrix and mutate.ts both see it",
		async () => {
			const spec = model(
				"Ini",
				"---- MODULE Ini ----\nEXTENDS Naturals\nVARIABLES x, y\nInit == x = 0 /\\ y = 7\nNext == x' = x /\\ y' = y\nSpec == Init /\\ [][Next]_<<x,y>>\nInv == y < 5\n====\n",
				"SPECIFICATION Spec\nINVARIANT Inv\n",
			);
			const matrix = path.join(path.dirname(spec), "matrix.json");
			fs.writeFileSync(matrix, JSON.stringify({ runs: [{ name: "bug", expect: "invariant", property: "Inv" }] }));
			const run = await bun("tlc.ts", [spec, "--matrix", matrix]);
			expect(run.out).toMatch(/^ok\s+bug: invariant Inv \(as expected\)/m);
			expect(run.code).toBe(0);
			const mutations = path.join(path.dirname(spec), "mutations.json");
			fs.writeFileSync(
				mutations,
				JSON.stringify({
					checker: { kind: "tlc", config: "Good.cfg" },
					properties: ["Inv"],
					mutations: [{ name: "bad-init", search: "y = 1", replace: "y = 7", breaks: "Inv" }],
				}),
			);
			fs.writeFileSync(path.join(path.dirname(spec), "Good.cfg"), "SPECIFICATION Spec\nINVARIANT Inv\n");
			fs.writeFileSync(spec, fs.readFileSync(spec, "utf8").replace("y = 7", "y = 1"));
			const mutated = await bun("mutate.ts", [spec, mutations]);
			expect(mutated.out).toMatch(/DETECTED\s+bad-init: failed on Inv/);
			expect(mutated.code).toBe(0);
		},
		120_000,
	);
});

describe("5: an action property named by its location", () => {
	const TEXT = [
		"Starting... (2026-10-28 23:21:05)",
		"Error: Action property line 7, col 10 to line 7, col 21 of module Act2 is violated.",
		"Error: The behavior up to this point is:",
		"State 1: <Initial predicate>",
		"x = 0",
		"",
		"State 2: <Next line 5, col 9 to line 5, col 27 of module Act2>",
		"x = 1",
		"",
		"2 states generated, 2 distinct states found, 0 states left on queue.",
	].join("\n");

	it("is outcome `action` with its source location", () => {
		const result = parseTlcOutput(TEXT, 13);
		expect(result.outcome).toBe("action");
		expect(result.property).toBeUndefined();
		expect(result.propertyLocation).toEqual({ module: "Act2", line: 7, col: 10, endLine: 7, endCol: 21 });
		expect(result.trace).toHaveLength(2);
	});

	it.skipIf(!REAL)(
		"a matrix expecting `action` of Mono2 passes: the name comes from the definition at that line",
		async () => {
			const spec = model(
				"Act2",
				"---- MODULE Act2 ----\nEXTENDS Naturals\nVARIABLES x\nInit == x = 0\nNext == x' = x + 1 /\\ x < 3\nSpec == Init /\\ [][Next]_x\nMono2 == [][x' = x]_x /\\ []TRUE\n====\n",
				"SPECIFICATION Spec\nPROPERTY Mono2\nCHECK_DEADLOCK FALSE\n",
			);
			const matrix = path.join(path.dirname(spec), "matrix.json");
			fs.writeFileSync(matrix, JSON.stringify({ runs: [{ name: "mono", expect: "action", property: "Mono2" }] }));
			const run = await bun("tlc.ts", [spec, "--matrix", matrix]);
			expect(run.out).toMatch(/^ok\s+mono: action Mono2 \(as expected\)/m);
			expect(run.code).toBe(0);
		},
		90_000,
	);
});

describe("6: an empty Init is not a pass", () => {
	const TEXT = [
		"Starting... (2026-10-28 23:20:27)",
		"Computing initial states...",
		"Finished computing initial states: 0 distinct states generated at 2026-10-28 23:20:27.",
		"Model checking completed. No error has been found.",
		"0 states generated, 0 distinct states found, 0 states left on queue.",
		"The depth of the complete state graph search is 0.",
	].join("\n");

	it("is an error that says there is no initial state", () => {
		const result = parseTlcOutput(TEXT, 0);
		expect(result.outcome).toBe("error");
		expect(result.message).toContain("no initial state");
	});

	it("a simulation run, which prints no distinct count, still passes", () => {
		const result = parseTlcOutput("Model checking completed. No error has been found.\n", 0);
		expect(result.outcome).toBe("pass");
	});
});

describe("7: a search that matches only inside a .tla comment", () => {
	const SOURCE = [
		"---- MODULE M ----",
		"\\* guard A is described here",
		"(* and (* nested *) guard A again *)",
		'Label == "\\* guard C is a string"',
		"Body == guard B",
		"====",
		"",
	].join("\n");

	it("is rejected as matching only inside comments", () => {
		const applied = applyMutation(SOURCE, { search: "guard A", replace: "x", all: false }, "M.tla");
		expect(applied.ok).toBe(false);
		if (!applied.ok) expect(applied.reason).toContain("only inside comments");
	});

	it("counts and replaces only the code occurrence, and treats a string as code", () => {
		const applied = applyMutation(SOURCE, { search: "guard B", replace: "TRUE", all: false }, "M.tla");
		expect(applied).toEqual({ ok: true, text: SOURCE.replace("Body == guard B", "Body == TRUE") });
		const inString = applyMutation(SOURCE, { search: "guard C", replace: "x", all: false }, "M.tla");
		expect(inString.ok).toBe(true);
	});

	it("an occurrence in code and one in a comment is still exactly once, and only the code one changes", () => {
		const source = "---- MODULE M ----\n\\* guard B here\nBody == guard B\n====\n";
		const applied = applyMutation(source, { search: "guard B", replace: "TRUE", all: false }, "M.tla");
		expect(applied).toEqual({ ok: true, text: "---- MODULE M ----\n\\* guard B here\nBody == TRUE\n====\n" });
	});

	it("a search that runs from code into its trailing comment is a code match", () => {
		const source = "---- MODULE M ----\n/\\ x' = 1   \\* the sync() after #hold\nNext == y\n====\n";
		const applied = applyMutation(
			source,
			{ search: "/\\ x' = 1   \\* the sync() after #hold", replace: "/\\ TRUE", all: false },
			"M.tla",
		);
		expect(applied).toEqual({ ok: true, text: "---- MODULE M ----\n/\\ TRUE\nNext == y\n====\n" });
	});

	it("other files are matched as before", () => {
		expect(applyMutation("-- guard\nguard\n", { search: "guard", replace: "x", all: false }, "P.lean").ok).toBe(
			false,
		);
		expect(applyMutation("-- guard A\n", { search: "guard A", replace: "x", all: false }, "P.lean").ok).toBe(true);
	});

	it("runMutations reports INVALID rather than MISSED", async () => {
		const root = fs.mkdtempSync(path.join(temp, "c-"));
		const file = path.join(root, "M.tla");
		fs.writeFileSync(file, SOURCE);
		const check: Checker = async () => ({ status: "pass", violated: [], detail: "ok" });
		const spec = parseMutations({
			checker: { kind: "command", command: ["unused"] },
			properties: ["P"],
			mutations: [{ name: "in-comment", search: "guard A", replace: "x", breaks: "P" }],
		});
		const report = await runMutations({ root, model: file, spec, properties: ["P"], check });
		expect(report.results[0]?.status).toBe("INVALID");
		expect(report.results[0]?.detail).toContain("only inside comments");
	});
});

describe("8: several constants on one line", () => {
	const CFG = "SPECIFICATION Spec\nCONSTANTS N = 3 M = 4\nCONSTANT S = {a, b} T <- Foo\nINVARIANT Inv\n";

	it("parseCfg reads each assignment", () => {
		expect(parseCfg(CFG).constants).toEqual({ N: "3", M: "4", S: "{a, b}", T: "Foo" });
	});

	it("overriding N keeps M, and a value with a nested set survives", () => {
		const parsed = parseCfg(overrideConstants(CFG, { N: "5" }));
		expect(parsed.constants).toEqual({ M: "4", S: "{a, b}", T: "Foo", N: "5" });
		expect(parsed.invariants).toEqual(["Inv"]);
		expect(parseCfg(overrideConstants(CFG, { S: "{c}" })).constants).toEqual({ N: "3", M: "4", T: "Foo", S: "{c}" });
	});

	it("a string value that contains `=` stays one value", () => {
		expect(parseCfg('CONSTANTS A = "x = y" B = 2\n').constants).toEqual({ A: '"x = y"', B: "2" });
	});

	it("isolateProperties is unaffected", () => {
		expect(isolateProperties("INVARIANT A B\n", ["B"])).toBe("INVARIANT B\n");
	});
});

describe("9: a multi-line (* @code *) block belongs to the definition below it", () => {
	const SOURCE = [
		"---- MODULE B ----",
		"\\* @code a.ts:1-2 first",
		"A == x' = 1",
		"(* @code b.ts:5-9 second",
		"   which spans several lines *)",
		"B == x' = 2",
		"====",
	].join("\n");

	it("tags B, not A", () => {
		const defs = indexDefinitions(SOURCE);
		expect(tagsFor(defs, "A", undefined).map(formatTag)).toEqual(["a.ts:1-2"]);
		expect(tagsFor(defs, "B", undefined).map(formatTag)).toEqual(["b.ts:5-9"]);
		expect(extractTags(SOURCE)).toHaveLength(2);
	});

	it("a single-line block comment and a comment block above stay attached", () => {
		const defs = indexDefinitions(
			"---- MODULE C ----\n(* @code c.ts:1 one *)\nC == TRUE\n(*\n  free text\n*)\n\\* @code d.ts:2 two\nD == TRUE\n====\n",
		);
		expect(tagsFor(defs, "C", undefined).map(formatTag)).toEqual(["c.ts:1"]);
		expect(tagsFor(defs, "D", undefined).map(formatTag)).toEqual(["d.ts:2"]);
	});
});

describe("10: an interrupted run leaves no TLC scratch folder", () => {
	it.skipIf(!REAL || process.platform === "win32")(
		"SIGINT removes the ompdesk-tlc-* folder",
		async () => {
			const spec = model(
				"Forever",
				"---- MODULE Forever ----\nEXTENDS Naturals\nVARIABLES x\nInit == x = 0\nNext == x' = x + 1\nSpec == Init /\\ [][Next]_x\n====\n",
				"SPECIFICATION Spec\n",
			);
			const tmp = fs.mkdtempSync(path.join(temp, "tmp-"));
			const child: ChildProcess = spawn("bun", [path.join(SKILL, "scripts/tlc.ts"), spec, "--timeout", "0"], {
				env: { ...process.env, OMPDESK_FORMAL_CACHE: CACHE, TMPDIR: tmp },
				stdio: "ignore",
			});
			const exited = new Promise<number | null>(resolve => child.on("exit", code => resolve(code)));
			const scratch = (): string | undefined => fs.readdirSync(tmp).find(name => name.startsWith("ompdesk-tlc-"));
			const deadline = Date.now() + 60_000;
			// TLC creates its metadir `states` inside the scratch folder once it runs. The only signal a child process
			// gives for that is the folder, so it is polled (until it appears, never for a fixed time).
			while (!(scratch() && fs.existsSync(path.join(tmp, scratch() as string, "states"))) && Date.now() < deadline) {
				await new Promise(resolve => setTimeout(resolve, 50));
			}
			expect(scratch()).toBeDefined();
			child.kill("SIGINT");
			await exited;
			expect(fs.readdirSync(tmp).filter(name => name.startsWith("ompdesk-tlc-"))).toEqual([]);
		},
		120_000,
	);
});

describe("11: removing scratch folders retries and never throws", () => {
	it("passes the retry options and turns a failure into a message", () => {
		const spy = vi.spyOn(fs, "rmSync").mockImplementation(() => {
			throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
		});
		try {
			expect(removeTree("/nonexistent/scratch")).toContain("EBUSY");
			expect(spy).toHaveBeenCalledWith(
				"/nonexistent/scratch",
				expect.objectContaining({ recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
			);
		} finally {
			spy.mockRestore();
		}
	});

	it("returns undefined on success", () => {
		const dir = fs.mkdtempSync(path.join(temp, "rm-"));
		expect(removeTree(dir)).toBeUndefined();
		expect(fs.existsSync(dir)).toBe(false);
	});
});

describe("12: java runs with UTF-8 file and stream encodings", () => {
	it.skipIf(!REAL)(
		"a non-ASCII value in a trace survives a non-UTF-8 locale",
		async () => {
			const spec = model(
				"Uni",
				'---- MODULE Uni ----\nVARIABLES s\nInit == s = "héllo wörld"\nNext == s\' = s\nSpec == Init /\\ [][Next]_s\nInv == s # "héllo wörld"\n====\n',
				"SPECIFICATION Spec\nINVARIANT Inv\n",
			);
			const run = await bun("tlc.ts", [spec], { LC_ALL: "C", LANG: "C", LC_CTYPE: "C" });
			expect(run.code).toBe(1);
			expect(run.out).toContain("héllo wörld");
		},
		90_000,
	);
});

describe("13: one worker by default, runs in parallel, parse errors", () => {
	it("defaultJobs is about half the cores, overridable, never below 1", () => {
		expect(defaultJobs({}, 8)).toBe(4);
		expect(defaultJobs({}, 1)).toBe(1);
		expect(defaultJobs({}, 3)).toBe(1);
		expect(defaultJobs({ OMPDESK_FORMAL_JOBS: "3" }, 8)).toBe(3);
		expect(defaultJobs({ OMPDESK_FORMAL_JOBS: "nonsense" }, 8)).toBe(4);
		expect(defaultJobs({ OMPDESK_FORMAL_JOBS: "0" }, 8)).toBe(4);
	});

	it("poolPromises never runs more than the limit at once and keeps the result order", async () => {
		let active = 0;
		let peak = 0;
		const gates = [0, 1, 2, 3, 4, 5].map(() => Promise.withResolvers<void>());
		const done = poolPromises([0, 1, 2, 3, 4, 5], 2, async item => {
			active++;
			peak = Math.max(peak, active);
			await gates[item]?.promise;
			active--;
			return item * 10;
		});
		for (const item of [3, 0, 5, 1, 4, 2]) gates[item]?.resolve();
		expect(await Promise.all(done)).toEqual([0, 10, 20, 30, 40, 50]);
		expect(peak).toBe(2);
	});

	it.skipIf(!REAL)(
		"the pattern matrix prints its runs in matrix order and a bug trace has the same length every time",
		async () => {
			const dir = path.join(temp, "JobLease");
			fs.cpSync(path.join(SKILL, "assets/patterns/JobLease"), dir, { recursive: true });
			const lengths: number[] = [];
			for (let i = 0; i < 3; i++) {
				const json = path.join(temp, `joblease-${i}.json`);
				const run = await bun("tlc.ts", [
					path.join(dir, "JobLease.tla"),
					"--matrix",
					path.join(dir, "matrix.json"),
					"--json",
					json,
					"--jobs",
					"3",
				]);
				expect(run.code).toBe(0);
				const order = [...run.out.matchAll(/^ok\s+(\w+):/gm)].map(match => match[1]);
				expect(order).toEqual(["fixed", "bug", "sanity"]);
				const report = JSON.parse(fs.readFileSync(json, "utf8"));
				lengths.push(report.runs[1].rows.length);
			}
			expect(new Set(lengths).size).toBe(1);
		},
		180_000,
	);

	it.skipIf(!REAL)(
		"a run is single-worker unless asked",
		async () => {
			const spec = model("Cnt", COUNTER("x < 2"), "SPECIFICATION Spec\nINVARIANT Inv\nCHECK_DEADLOCK FALSE\n");
			const log = path.join(temp, "workers-out");
			const run = await bun("tlc.ts", [spec, "--out", log]);
			expect(run.code).toBe(1);
			const text = fs.readFileSync(path.join(log, fs.readdirSync(log)[0] as string), "utf8");
			expect(text).toMatch(/with 1 worker /);
		},
		90_000,
	);

	it.skipIf(!REAL)(
		"a SANY parse error prints where it is and exits 2, with and without --sany-only",
		async () => {
			const spec = model(
				"Par",
				"---- MODULE Par ----\nEXTENDS Naturals\nVARIABLES x\nInit == x = = 3\n====\n",
				"SPECIFICATION Spec\n",
			);
			const sany = await bun("tlc.ts", [spec, "--sany-only"]);
			expect(sany.code).toBe(2);
			expect(sany.out).toMatch(/Encountered "3" at line 4, column 15/);
			const full = await bun("tlc.ts", [spec]);
			expect(full.code).toBe(2);
			expect(full.out).toMatch(/Encountered "3" at line 4, column 15/);
		},
		90_000,
	);

	it("a parse error's message carries the Encountered line", () => {
		const result = parseTlcOutput(
			[
				"***Parse Error***",
				'Was expecting "==== or more Module body"',
				'Encountered "3" at line 4, column 15 and token "=" ',
				"",
				"Residual stack trace follows:",
				"",
				"Fatal errors while parsing TLA+ spec in file Par",
				"Error: Parsing or semantic analysis failed.",
			].join("\n"),
			150,
		);
		expect(result.outcome).toBe("parse-error");
		expect(result.message).toContain("line 4, column 15");
		expect(result.message).toContain("Was expecting");
	});
});

describe("14 to 18: the skill's text", () => {
	const read = (file: string): string => fs.readFileSync(path.join(SKILL, file), "utf8");

	it("14: the description opens with the tested trigger sentence", () => {
		const description = /^description: "(.*)"$/m.exec(read("SKILL.md"))?.[1] ?? "";
		expect(description.slice(0, 100)).toBe(
			"Read before fixing a race, or a bug where something runs twice or out of order, or proving it never can.".slice(
				0,
				100,
			),
		);
	});

	it("15: distinct 0 is no longer called a dead action", () => {
		for (const file of [
			"references/simplify-catalog.md",
			"references/mutations.md",
			"references/tla-pitfalls.md",
			"references/tlc-cli.md",
		]) {
			expect(read(file)).not.toMatch(/\b0 distinct states\b/i);
		}
		expect(read("scripts/lib/tlc-run.ts")).not.toContain("generated:distinct");
	});

	it("16: the CI copy list names the findings schema and the Lean template", () => {
		const ci = read("references/ci-and-drift.md");
		expect(ci).toContain("assets/findings.schema.json");
		expect(ci).toContain("assets/lean-template");
	});

	it("17: the heap flag is documented through JAVA_TOOL_OPTIONS", () => {
		const doc = read("references/tlc-cli.md");
		expect(doc).toContain("JAVA_TOOL_OPTIONS=-Xmx8g");
		expect(doc).not.toMatch(/-- -Xmx/);
	});

	it("18: the first Lean install runs once on its own with a long timeout", () => {
		expect(read("SKILL.md")).toMatch(/setup\.ts lean[^\n]*1800/);
	});
});
