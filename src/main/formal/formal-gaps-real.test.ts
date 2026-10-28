/**
 * Opt-in (OMP_GUI_REAL_FORMAL=1): the dogfood gaps that need a real TLC run: the `--sany-only` load check, the
 * `trace[]` rows of `--json`, `@code` through a wrapper action, the timeout message, the `deadlock` and `isolate`
 * mutation options, and the EventLoop pattern with every mutation DETECTED.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validate } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/schema";

const SKILL = path.join(__dirname, "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify");
const REAL = process.env.OMP_GUI_REAL_FORMAL === "1";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "formal-gaps-real-"));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const cache = path.join(temp, "cache");

function bunRun(script: string, args: string[]): Promise<{ code: number | null; out: string }> {
	const { promise, resolve } = Promise.withResolvers<{ code: number | null; out: string }>();
	execFile(
		"bun",
		[path.join(SKILL, "scripts", script), ...args],
		{
			encoding: "utf8",
			env: { ...process.env, OMPDESK_FORMAL_CACHE: cache },
			maxBuffer: 64 * 1024 * 1024,
		},
		(error, stdout, stderr) => {
			resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out: `${stdout}${stderr}` });
		},
	);
	return promise;
}

function write(name: string, text: string): string {
	const file = path.join(temp, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

describe.skipIf(!REAL)("dogfood gaps on the real TLC", () => {
	it("--sany-only fails a semantic error (SANY -error-codes, exit 2), and passes it once the spec EXTENDS Integers", async () => {
		const body = (extends_: string): string =>
			`---- MODULE Neg ----\n${extends_}VARIABLES x\nInit == x = -1\nNext == x' = x\nSpec == Init /\\ [][Next]_x\n====\n`;
		const cfg = "SPECIFICATION Spec\n";
		write("neg/Neg.cfg", cfg);
		const bad = write("neg/Neg.tla", body("EXTENDS Naturals\n"));
		const failed = await bunRun("tlc.ts", [bad, "--sany-only"]);
		expect(failed.code).toBe(2);
		expect(failed.out).toContain("SANY found errors");
		expect(failed.out).toContain("'-.'");
		fs.writeFileSync(bad, body("EXTENDS Integers\n"));
		const fixed = await bunRun("tlc.ts", [bad, "--sany-only"]);
		expect(fixed.code).toBe(0);
		expect(fixed.out).toContain("TLC loads the model");
		fs.rmSync(path.join(temp, "neg/Neg.cfg"));
		const noConfig = await bunRun("tlc.ts", [bad, "--sany-only"]);
		expect(noConfig.code).toBe(0);
		expect(noConfig.out).toContain("load check did not run");
	}, 90_000);

	it("--json writes trace[] rows the findings schema accepts, the real TLC version, and @code through a wrapper", async () => {
		write("wrap/a.ts", "1\n2\n3\n");
		write(
			"wrap/Wrap.tla",
			[
				"---- MODULE Wrap ----",
				"EXTENDS Naturals",
				"VARIABLES x, y",
				"Init == x = 0 /\\ y = 0",
				"\\* @code a.ts:1-2 step",
				"Step(p) == /\\ x < 3 /\\ x' = x + p[1] /\\ y' = p[2]",
				"Pairs == {<<1,1>>, <<2,2>>}",
				"ResumeStep ==",
				"  \\E p \\in Pairs :",
				"    /\\ p[1] > 0",
				"    /\\ Step(p)",
				"Next == ResumeStep",
				"Spec == Init /\\ [][Next]_<<x, y>>",
				"Inv == x < 3",
				"====",
				"",
			].join("\n"),
		);
		write("wrap/Wrap.cfg", "SPECIFICATION Spec\nINVARIANT Inv\n");
		const json = path.join(temp, "wrap/out.json");
		const run = await bunRun("tlc.ts", [
			path.join(temp, "wrap/Wrap.tla"),
			"--code-root",
			path.join(temp, "wrap"),
			"--json",
			json,
		]);
		expect(run.code).toBe(1);
		expect(run.out).toMatch(/ResumeStep {3}\[a\.ts:1-2\]/);
		const result = JSON.parse(fs.readFileSync(json, "utf8"));
		expect(result.tlcVersion).toMatch(/^\d{4}\.\d+\.\d+/);
		const schema = JSON.parse(fs.readFileSync(path.join(SKILL, "assets/findings.schema.json"), "utf8"));
		const rowSchema = schema.properties.findings.items.properties.trace.items;
		expect(result.trace.length).toBeGreaterThan(1);
		for (const row of result.trace) expect(validate(row, rowSchema)).toEqual([]);
		expect(result.trace[1].code).toBe("a.ts:1-2");
		expect(result.trace.at(-1).violation).toBe(true);
		expect(result.rows[1].code).toEqual(["a.ts:1-2"]);
	}, 90_000);

	it("a run past --timeout ends as timed out and says which limit stopped it", async () => {
		write(
			"slow/Slow.tla",
			"---- MODULE Slow ----\nEXTENDS Naturals\nVARIABLES x\nInit == x = 0\nNext == x' = x + 1\nSpec == Init /\\ [][Next]_x\n====\n",
		);
		write("slow/Slow.cfg", "SPECIFICATION Spec\n");
		const run = await bunRun("tlc.ts", [path.join(temp, "slow/Slow.tla"), "--timeout", "3"]);
		expect(run.code).toBe(1);
		expect(run.out).toContain("timed out (no verdict)");
		expect(run.out).toContain("stopped after 3 s without a verdict");
		expect(run.out).toContain("--timeout 0");
	}, 90_000);

	it("a liveness mutation needs deadlock:false, and isolate names the property it targets", async () => {
		const spec = [
			"---- MODULE Count ----",
			"EXTENDS Naturals",
			"VARIABLES x",
			"Init == x = 0",
			"Tick == x < 2 /\\ x' = x + 1",
			"Terminated == x = 2 /\\ UNCHANGED x",
			"Next == Tick \\/ Terminated",
			"Spec == Init /\\ [][Next]_x /\\ WF_x(Tick)",
			"Small == x <= 2",
			"Big == x <= 3",
			"Done == <>(x = 2)",
			"====",
			"",
		].join("\n");
		write("count/Count.tla", spec);
		write("count/Count.cfg", "SPECIFICATION Spec\nINVARIANTS\n    Small\n    Big\nPROPERTY Done\n");
		const mutations = (extra: Record<string, unknown>) =>
			JSON.stringify({
				checker: { kind: "tlc", config: "Count.cfg" },
				waive: { Big: "weaker than Small, no mutation is useful for it" },
				mutations: [
					{ name: "stop-early", search: "Tick == x < 2", replace: "Tick == x < 1", breaks: "Done", ...extra },
					{
						name: "overshoot",
						search: "Tick == x < 2 /\\ x' = x + 1",
						replace: "Tick == x < 4 /\\ x' = x + 1",
						breaks: "Small",
						isolate: true,
					},
				],
			});
		const file = write("count/mutations.json", mutations({}));
		const model = path.join(temp, "count/Count.tla");
		const plain = await bunRun("mutate.ts", [model, file]);
		expect(plain.code).toBe(1);
		expect(plain.out).toMatch(/MISSED +stop-early: failed on deadlock, not on Done.*"deadlock": false/);
		expect(plain.out).toContain("DETECTED overshoot: failed on Small");
		fs.writeFileSync(file, mutations({ deadlock: false }));
		const fixed = await bunRun("mutate.ts", [model, file]);
		expect(fixed.out).toContain("DETECTED stop-early: failed on Done");
		expect(fixed.code).toBe(0);
		// the same mutation without isolate: TLC names Big or Small, whichever it finds first
		const unisolated = JSON.parse(mutations({ deadlock: false }));
		delete unisolated.mutations[1].isolate;
		unisolated.mutations[1].breaks = "Big";
		unisolated.mutations[1].replace = "Tick == x < 5 /\\ x' = x + 1";
		fs.writeFileSync(file, JSON.stringify(unisolated));
		const mixed = await bunRun("mutate.ts", [model, file]);
		expect(mixed.out).toMatch(/MISSED +overshoot: failed on Small, not on Big/);
		unisolated.mutations[1].isolate = true;
		fs.writeFileSync(file, JSON.stringify(unisolated));
		expect((await bunRun("mutate.ts", [model, file])).out).toContain("DETECTED overshoot: failed on Big");
	}, 180_000);

	it("the EventLoop pattern passes its matrix and detects every mutation", async () => {
		const dir = path.join(SKILL, "assets/patterns/EventLoop");
		const matrix = await bunRun("tlc.ts", [
			path.join(dir, "EventLoop.tla"),
			"--matrix",
			path.join(dir, "matrix.json"),
		]);
		expect(matrix.out).toContain("PASS  matrix: all 3 runs ended as expected");
		const mutated = await bunRun("mutate.ts", [path.join(dir, "EventLoop.tla"), path.join(dir, "mutations.json")]);
		expect(mutated.out).toContain("4 of 4 mutations detected");
		expect(mutated.out).not.toMatch(/MISSED|UNCOVERED|INVALID/);
		expect(mutated.code).toBe(0);
	}, 120_000);

	it("verify-all stamps a model before its files are committed, and prints DRIFT instead of ok", async () => {
		const root = path.join(temp, "stamp");
		const run = (cmd: string, args: string[]): Promise<string> =>
			new Promise(resolve =>
				execFile(cmd, args, { cwd: root, encoding: "utf8" }, (_e, out, err) => resolve(`${out}${err}`)),
			);
		const git = (...args: string[]): Promise<string> =>
			run("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args]);
		write("stamp/src/code.ts", "export function f() {\n\treturn 1;\n}\n\nexport function g() {\n\treturn 2;\n}\n");
		await git("init", "-q");
		await git("add", "-A");
		await git("commit", "-q", "-m", "code");
		// The model files are written after the commit and stay untracked: the stamp sha does not contain them.
		const model = path.join(SKILL, "examples/job-lease/formal");
		fs.cpSync(model, path.join(root, "formal"), { recursive: true });
		const manifestFile = path.join(root, "formal/manifest.json");
		const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
		manifest.models[0].covers = ["src/code.ts#f"];
		fs.writeFileSync(manifestFile, JSON.stringify(manifest));
		fs.cpSync(path.join(SKILL, "examples/job-lease/src/worker.ts"), path.join(root, "src/worker.ts"));
		const stamped = await bunRun("verify-all.ts", [path.join(root, "formal"), "--stamp", "--skip-mutations"]);
		expect(stamped.out).toMatch(/stamp: job-lease syncCommit = [0-9a-f]{10}\n/);
		expect(JSON.parse(fs.readFileSync(manifestFile, "utf8")).models[0].syncCommit).toMatch(/^[0-9a-f]{40}$/);
		// An edit of g (not covered) is no drift; an edit of f is, and is printed as DRIFT, never as ok.
		write("stamp/src/code.ts", "export function f() {\n\treturn 1;\n}\n\nexport function g() {\n\treturn 3;\n}\n");
		expect((await bunRun("verify-all.ts", [path.join(root, "formal"), "--skip-mutations"])).out).toMatch(
			/^ok +job-lease: drift/m,
		);
		write("stamp/src/code.ts", "export function f() {\n\treturn 9;\n}\n\nexport function g() {\n\treturn 2;\n}\n");
		const drifted = await bunRun("verify-all.ts", [path.join(root, "formal"), "--skip-mutations"]);
		expect(drifted.out).toMatch(/^DRIFT {2}job-lease: drift - DRIFT:/m);
		expect(drifted.out).not.toMatch(/^ok {2}job-lease: drift - DRIFT/m);
		expect(drifted.out).toContain("changed since sync: src/code.ts#f");
		expect(drifted.code).toBe(0);
		expect(
			(await bunRun("verify-all.ts", [path.join(root, "formal"), "--skip-mutations", "--strict-drift"])).code,
		).toBe(1);
		const refused = await bunRun("verify-all.ts", [path.join(root, "formal"), "--stamp", "--skip-mutations"]);
		expect(refused.out).toContain("not stamped: the covered code has uncommitted changes");
		const allowed = await bunRun("verify-all.ts", [
			path.join(root, "formal"),
			"--stamp",
			"--allow-dirty",
			"--skip-mutations",
		]);
		expect(allowed.out).toContain("uncommitted covered changes");
		expect(JSON.parse(fs.readFileSync(manifestFile, "utf8")).models[0].syncDiff).toMatch(/^[0-9a-f]{64}$/);
		expect(
			(await bunRun("verify-all.ts", [path.join(root, "formal"), "--skip-mutations", "--strict-drift"])).code,
		).toBe(0);
	}, 240_000);
});
