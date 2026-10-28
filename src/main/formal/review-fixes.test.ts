/**
 * The independent review's findings (M1 to M8 and the minors), each pinned by a case named after it. M1 to M4 are
 * honesty bugs (a pass or DETECTED that was not real): their cases fail on the code they were written against.
 *
 * `FORMAL_SKILL_DIR` points the cases at another copy of the skill (a `git archive` of an older commit), which is how
 * the failing-first output was produced. Cases that need the real Lean toolchain run with `OMP_GUI_REAL_FORMAL=1`.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SKILL =
	process.env.FORMAL_SKILL_DIR ??
	path.join(__dirname, "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify");
const REAL = process.env.OMP_GUI_REAL_FORMAL === "1";
const CACHE = process.env.OMPDESK_FORMAL_CACHE ?? path.join(os.tmpdir(), "formal-cache");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "formal-review-"));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

// biome-ignore lint/suspicious/noExplicitAny: the library is loaded from a path chosen at run time.
async function lib(name: string): Promise<any> {
	return import(/* @vite-ignore */ path.join(SKILL, "scripts/lib", `${name}.ts`));
}

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

function copyExample(name: string): string {
	const dest = fs.mkdtempSync(path.join(temp, `${name}-`));
	fs.cpSync(path.join(SKILL, "examples", name), dest, { recursive: true });
	return path.join(dest, "formal");
}

describe("M1: the Lean trust audit sees private theorems, hidden defs and a sorry that no source line spells", () => {
	const HACK = [
		"import Lean",
		"open Lean Elab Tactic in",
		'elab "trust_me" : tactic => do (← getMainGoal).admit',
		"def hidden_def : 2 = 3 := by trust_me",
		"private theorem priv_thm : 3 = 4 := by trust_me",
		"theorem fine : 1 + 1 = 2 := rfl",
		"",
	].join("\n");

	function project(): string {
		const dir = fs.mkdtempSync(path.join(temp, "hack-"));
		fs.mkdirSync(path.join(dir, "Byp"));
		fs.writeFileSync(
			path.join(dir, "lakefile.toml"),
			'name = "byp"\ndefaultTargets = ["Byp"]\n\n[[lean_lib]]\nname = "Byp"\n',
		);
		fs.writeFileSync(path.join(dir, "lean-toolchain"), "leanprover/lean4:v4.35.0\n");
		fs.writeFileSync(path.join(dir, "Byp.lean"), "import Byp.Hack\n");
		fs.writeFileSync(path.join(dir, "Byp", "Hack.lean"), HACK);
		return dir;
	}

	it.skipIf(!REAL)(
		"fails a project whose proofs are admitted by a custom tactic, and names both declarations",
		async () => {
			const run = await bun("lean-check.ts", [project(), "--json"]);
			expect(run.code).toBe(1);
			const check = JSON.parse(run.out.slice(run.out.indexOf("{")));
			expect(check.status).toBe("fail");
			const flagged = check.theorems
				.filter((theorem: { flag?: string }) => theorem.flag === "SORRY")
				.map((theorem: { name: string }) => theorem.name);
			expect(flagged).toContain("hidden_def");
			expect(flagged).toContain("priv_thm");
			expect(
				check.theorems.some((theorem: { name: string; flag?: string }) => theorem.name === "fine" && !theorem.flag),
			).toBe(true);
			expect(
				check.findings.some((finding: { text: string }) => finding.text.includes("declaration uses 'sorry'")),
			).toBe(true);
		},
		300_000,
	);

	it("treats the new axiom name of decide +native as native_decide, so --allow-native can allow it", async () => {
		const { flagAxioms } = await lib("lean-trust");
		expect(flagAxioms(["nat_thm._native.decide.ax_1_1"], false)).toBe("NATIVE");
		expect(flagAxioms(["nat_thm._native.decide.ax_1_1"], true)).toBeUndefined();
		expect(flagAxioms(["Lean.ofReduceBool"], false)).toBe("NATIVE");
		expect(flagAxioms(["propext", "Classical.choice", "Quot.sound"], false)).toBeUndefined();
		expect(flagAxioms(["bad_ax"], true)).toBe("AXIOM:bad_ax");
		expect(flagAxioms(["sorryAx"], true)).toBe("SORRY");
	});
});

describe("M2: a name or syntax error in a mutated Lean model is INVALID, never DETECTED", () => {
	it("classifies unknown identifiers, unexpected tokens and unknown tactics as naming errors, not unsolved goals", async () => {
		const { isNamingError } = await lib("lean-trust");
		for (const message of [
			"Unknown identifier `init`",
			"unknown constant 'Foo.bar'",
			"unknown tactic",
			"unexpected token ':='; expected term",
			"invalid field 'x', the environment does not contain 'Nat.x'",
		]) {
			expect(isNamingError(message), message).toBe(true);
		}
		for (const message of [
			"unsolved goals",
			"omega could not prove the goal",
			"type mismatch",
			"The rfl tactic failed",
		]) {
			expect(isNamingError(message), message).toBe(false);
		}
	});

	it.skipIf(!REAL)(
		"renaming init in the bounded-queue example is INVALID (exit 2), not DETECTED",
		async () => {
			const formal = copyExample("bounded-queue");
			const lean = path.join(formal, "bounded-queue/lean");
			const file = path.join(lean, "mutations.json");
			const spec = JSON.parse(fs.readFileSync(file, "utf8"));
			spec.mutations = [
				{
					name: "rename-init",
					file: "BoundedQueue/System.lean",
					search: "def init (cap",
					replace: "def init0 (cap",
					breaks: ["never_overflows", "nothing_lost"],
				},
			];
			fs.writeFileSync(file, JSON.stringify(spec));
			const run = await bun("mutate.ts", [path.join(lean, "BoundedQueue/Properties.lean"), file]);
			expect(run.out).toContain("INVALID  rename-init");
			expect(run.out).not.toContain("DETECTED");
			expect(run.code).toBe(2);
		},
		300_000,
	);
});

describe("M3: a mutation's own config is baselined on the unmutated model", () => {
	const spec = async (config?: string): Promise<unknown> => {
		const { parseMutations } = await lib("mutate-core");
		return parseMutations({
			checker: { kind: "tlc", config: "MC.cfg" },
			properties: ["SingleCommit"],
			mutations: [
				{
					name: "edit-a-comment-only",
					search: "unrelated",
					replace: "changed",
					breaks: "SingleCommit",
					...(config ? { config } : {}),
				},
			],
		});
	};

	// A model is a text file; the fake checker fails under the bug config whatever the text says, as TLC does on MC_bug.cfg.
	const checker = async (_dir: string, model: string, mutation?: { config?: string }): Promise<unknown> => {
		const text = fs.readFileSync(model, "utf8");
		if ((mutation?.config ?? "MC.cfg") === "MC_bug.cfg")
			return { status: "fail", violated: ["SingleCommit"], detail: "violated" };
		return text.includes("guard")
			? { status: "pass", violated: [], detail: "ok" }
			: { status: "fail", violated: ["SingleCommit"], detail: "violated" };
	};

	function model(): { root: string; file: string } {
		const root = fs.mkdtempSync(path.join(temp, "m3-"));
		const file = path.join(root, "model.txt");
		fs.writeFileSync(file, "guard\nunrelated\n");
		return { root, file };
	}

	it("makes a comment-only mutation INVALID when its config already fails on the unmutated model", async () => {
		const { runMutations, mutationExitCode } = await lib("mutate-core");
		const { root, file } = model();
		const report = await runMutations({
			root,
			model: file,
			spec: await spec("MC_bug.cfg"),
			properties: ["SingleCommit"],
			check: checker,
		});
		expect(report.results.map((result: { status: string }) => result.status)).toEqual(["INVALID"]);
		expect(report.results[0].detail).toContain("does not pass under MC_bug.cfg");
		expect(mutationExitCode(report)).toBe(2);
	});

	it("still judges a mutation whose own config passes on the unmutated model", async () => {
		const { runMutations } = await lib("mutate-core");
		const { root, file } = model();
		const report = await runMutations({
			root,
			model: file,
			spec: await spec("MC_other.cfg"),
			properties: ["SingleCommit"],
			check: checker,
		});
		expect(report.results.map((result: { status: string }) => result.status)).toEqual(["MISSED"]);
	});

	it("baselines each distinct config once", async () => {
		const { runMutations, parseMutations } = await lib("mutate-core");
		const { root, file } = model();
		const calls: string[] = [];
		const counting = async (dir: string, modelFile: string, mutation?: { config?: string }): Promise<unknown> => {
			calls.push(`${path.basename(dir)}:${mutation?.config ?? "-"}`);
			return checker(dir, modelFile, mutation);
		};
		const two = parseMutations({
			checker: { kind: "tlc" },
			properties: ["SingleCommit"],
			mutations: [
				{ name: "a", search: "unrelated", replace: "x", breaks: "SingleCommit", config: "MC_other.cfg" },
				{ name: "b", search: "unrelated", replace: "y", breaks: "SingleCommit", config: "MC_other.cfg" },
			],
		});
		await runMutations({ root, model: file, spec: two, properties: ["SingleCommit"], check: counting });
		expect(calls.filter(call => call === "baseline:MC_other.cfg")).toHaveLength(1);
	});

	it.skipIf(!REAL)(
		"the real job-lease example: comment-only mutation under MC_bug.cfg is INVALID (exit 2)",
		async () => {
			const formal = copyExample("job-lease");
			const tla = path.join(formal, "job-lease/tla");
			const file = path.join(tla, "mutations.json");
			fs.writeFileSync(
				file,
				JSON.stringify({
					checker: { kind: "tlc", config: "MC.cfg" },
					mutations: [
						{
							name: "edit-a-comment-only",
							search: "Adapted from",
							replace: "Taken from",
							breaks: "SingleCommit",
							config: "MC_bug.cfg",
						},
					],
				}),
			);
			const run = await bun("mutate.ts", [path.join(tla, "JobLease.tla"), file]);
			expect(run.out).toContain("INVALID  edit-a-comment-only");
			expect(run.out).not.toContain("DETECTED");
			expect(run.code).toBe(2);
		},
		120_000,
	);

	it("a mutation's file that leaves the model's folder is INVALID and nothing outside is touched", async () => {
		const { runMutations, parseMutations } = await lib("mutate-core");
		const { root, file } = model();
		const outside = path.join(path.dirname(root), "outside-target.txt");
		fs.writeFileSync(outside, "guard\n");
		const escaping = parseMutations({
			checker: { kind: "tlc" },
			properties: ["P"],
			mutations: [
				{ name: "escape", file: `../${path.basename(outside)}`, search: "guard", replace: "x", breaks: "P" },
			],
		});
		const report = await runMutations({ root, model: file, spec: escaping, properties: [], check: checker });
		expect(report.results[0].status).toBe("INVALID");
		expect(report.results[0].detail).toContain("outside");
		expect(fs.readFileSync(outside, "utf8")).toBe("guard\n");
	});
});

describe("M4: a TLC run that was killed, cut short or silent is no verdict, never a pass", () => {
	const PROGRESS =
		"TLC2 Version 2026.10.28\nStarting...\nProgress(3) at 2026-10-28: 43 states generated, 25 distinct states found.\n";

	it("reads a killed TLC (no exit code), a truncated log and empty output as an error", async () => {
		const { parseTlcOutput } = await lib("tlc-parse");
		expect(parseTlcOutput(PROGRESS, null).outcome).toBe("error");
		expect(parseTlcOutput(PROGRESS).outcome).toBe("error");
		expect(parseTlcOutput("", null).outcome).toBe("error");
		expect(parseTlcOutput("").outcome).toBe("error");
		expect(parseTlcOutput(PROGRESS, 137).outcome).toBe("error");
	});

	it("still passes on exit 0, and on a saved log that carries TLC's own completion line", async () => {
		const { parseTlcOutput } = await lib("tlc-parse");
		expect(parseTlcOutput(PROGRESS, 0).outcome).toBe("pass");
		expect(parseTlcOutput(`${PROGRESS}Model checking completed. No error has been found.\n`).outcome).toBe("pass");
		expect(parseTlcOutput("Model checking completed. No error has been found.\n", null).outcome).toBe("error");
	});

	it("tlc.ts --from-log of a truncated log exits 1 and does not say PASS", () => {
		const log = path.join(temp, "truncated.log");
		fs.writeFileSync(log, PROGRESS);
		const run = spawnSync("bun", [path.join(SKILL, "scripts/tlc.ts"), "--from-log", log], { encoding: "utf8" });
		expect(run.status).toBe(1);
		expect(run.stdout).not.toContain("PASS");
		expect(run.stdout).toContain("FAIL");
		expect(run.stdout).toContain("No verdict");
	});

	it("maps TLC's own exit codes: 14 is an assertion, 150 and 151 parse and configuration, 152, 153, 255 and 75 are no verdict", async () => {
		const { parseTlcOutput } = await lib("tlc-parse");
		const outcome = (code: number): string => parseTlcOutput("", code).outcome;
		expect([outcome(14), outcome(150), outcome(151)]).toEqual(["assert", "parse-error", "parse-error"]);
		expect([outcome(152), outcome(153), outcome(255), outcome(75)]).toEqual(["error", "error", "error", "error"]);
	});

	it("does not mark a violation on the last step of an evaluation error", async () => {
		const { parseTlcOutput, reduceTrace } = await lib("tlc-parse");
		const text = [
			"Error: Attempted to apply function to a non-function.",
			"Error: The behavior up to this point is:",
			"State 1: <Initial predicate>",
			"/\\ x = 0",
			"",
			"State 2: <Next line 3, col 1 to line 3, col 9 of module E>",
			"/\\ x = 1",
			"",
		].join("\n");
		const result = parseTlcOutput(text, 75);
		expect(result.outcome).toBe("error");
		expect(result.message).toContain("non-function");
		const rows = reduceTrace(result.trace, { outcome: result.outcome });
		expect(rows.some((row: { violation?: boolean }) => row.violation)).toBe(false);
	});
});

describe("M5: an interrupted script leaves no java or lake child behind", () => {
	it.skipIf(process.platform === "win32")(
		"a SIGTERM'd script's child process is gone",
		async () => {
			const script = path.join(temp, "hold.ts");
			const pidFile = path.join(temp, "grandchild.pid");
			fs.writeFileSync(
				script,
				[
					`import { run } from ${JSON.stringify(path.join(SKILL, "scripts/lib/proc.ts"))};`,
					`const code = "require('node:fs').writeFileSync(" + JSON.stringify(${JSON.stringify(pidFile)}) + ", String(process.pid)); setInterval(() => {}, 1000)";`,
					"await run(process.execPath, ['-e', code]);",
					"",
				].join("\n"),
			);
			const child = spawn("bun", [script], { stdio: "ignore" });
			let grandchild = 0;
			for (let i = 0; i < 100 && grandchild === 0; i++) {
				await new Promise(r => setTimeout(r, 100));
				if (fs.existsSync(pidFile)) grandchild = Number(fs.readFileSync(pidFile, "utf8")) || 0;
			}
			expect(grandchild).toBeGreaterThan(0);
			expect(() => process.kill(grandchild, 0)).not.toThrow();
			const { promise: exited, resolve: done } = Promise.withResolvers<void>();
			child.on("exit", () => done());
			child.kill("SIGTERM");
			await exited;
			let alive = true;
			for (let i = 0; i < 40 && alive; i++) {
				try {
					process.kill(grandchild, 0);
					await new Promise(r => setTimeout(r, 100));
				} catch {
					alive = false;
				}
			}
			if (alive) process.kill(grandchild, "SIGKILL");
			expect(alive).toBe(false);
		},
		30_000,
	);
});

describe("M6: the install lock knows a dead holder, keeps a live one, and the leftovers of a killed setup go", () => {
	function deadPid(): number {
		const probe = spawnSync(process.execPath, ["-e", ""]);
		return probe.pid ?? 999_999_999;
	}

	function plant(cache: string, name: string, pid: number, ageMs = 0): string {
		const lock = path.join(cache, `.lock-${name}`);
		fs.mkdirSync(lock, { recursive: true });
		const owner = path.join(lock, "owner.json");
		fs.writeFileSync(owner, JSON.stringify({ pid, host: os.hostname(), started: Date.now() - ageMs }));
		const then = new Date(Date.now() - ageMs);
		fs.utimesSync(owner, then, then);
		return lock;
	}

	it("takes over at once a lock whose holder pid is no longer running", async () => {
		const { withLock } = await lib("toolchain");
		const cache = fs.mkdtempSync(path.join(temp, "lock-dead-"));
		plant(cache, "lean", deadPid());
		const notes: string[] = [];
		const started = Date.now();
		const value = await withLock(cache, "lean", async () => 7, {
			log: (line: string) => notes.push(line),
			pollMs: 20,
		});
		expect(value).toBe(7);
		expect(Date.now() - started).toBeLessThan(3000);
		expect(notes.join("\n")).toContain("no longer running");
		expect(fs.existsSync(path.join(cache, ".lock-lean"))).toBe(false);
	});

	it("does not take a live holder's lock however old it looks, and says that it waits", async () => {
		const { withLock } = await lib("toolchain");
		const cache = fs.mkdtempSync(path.join(temp, "lock-live-"));
		const lock = plant(cache, "tla", process.pid, 60 * 60_000);
		const notes: string[] = [];
		let got = false;
		// The holder here is this process, whose heartbeat is not running: a lock this old with a live pid is stale by
		// the clock, so use a long threshold to say "somebody is working" and release it from outside.
		const waiting = withLock(
			cache,
			"tla",
			async () => {
				got = true;
			},
			{ log: (line: string) => notes.push(line), pollMs: 20, staleMs: 24 * 60 * 60_000 },
		);
		await new Promise(r => setTimeout(r, 300));
		expect(got).toBe(false);
		fs.rmSync(lock, { recursive: true, force: true });
		await waiting;
		expect(got).toBe(true);
	});

	it("a holder that heartbeats keeps its lock past the stale threshold", async () => {
		const { withLock } = await lib("toolchain");
		const cache = fs.mkdtempSync(path.join(temp, "lock-beat-"));
		const order: string[] = [];
		const holder = withLock(
			cache,
			"x",
			async () => {
				order.push("a-start");
				await new Promise(r => setTimeout(r, 700));
				order.push("a-end");
			},
			{ heartbeatMs: 40, staleMs: 250, pollMs: 20, log: () => {} },
		);
		await new Promise(r => setTimeout(r, 60));
		const waiter = withLock(cache, "x", async () => void order.push("b"), {
			heartbeatMs: 40,
			staleMs: 250,
			pollMs: 20,
			log: () => {},
		});
		await Promise.all([holder, waiter]);
		expect(order).toEqual(["a-start", "a-end", "b"]);
	}, 20_000);

	it("removes the .part and .tmp leftovers of dead pids, and keeps those of a live one", async () => {
		const { withLock, cleanLeftovers } = await lib("toolchain");
		const cache = fs.mkdtempSync(path.join(temp, "lock-clean-"));
		const dead = deadPid();
		fs.mkdirSync(path.join(cache, "downloads"), { recursive: true });
		fs.mkdirSync(path.join(cache, "elan", "toolchains"), { recursive: true });
		const gone = [
			path.join(cache, "downloads", `lean.zip.part-${dead}`),
			path.join(cache, "elan", "toolchains", `leanprover--lean4---v4.35.0.tmp-${dead}`),
		];
		fs.writeFileSync(gone[0] as string, "x");
		fs.mkdirSync(gone[1] as string);
		fs.writeFileSync(path.join(gone[1] as string, "big"), "x");
		const kept = path.join(cache, "downloads", `other.zip.part-${process.pid}`);
		fs.writeFileSync(kept, "x");
		const notes: string[] = [];
		await withLock(cache, "lean", async () => undefined, { log: (line: string) => notes.push(line) });
		expect(gone.map(file => fs.existsSync(file))).toEqual([false, false]);
		expect(fs.existsSync(kept)).toBe(true);
		expect(notes.join("\n")).toContain("unfinished");
		expect(cleanLeftovers(cache)).toEqual([]);
	});

	it("gives up on a download that sends nothing, leaving no .part file", async () => {
		const { download } = await lib("toolchain");
		const server = http.createServer((_request, response) => {
			response.writeHead(200, { "content-length": "1000000" });
			response.write("abc");
		});
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as { port: number };
		const dest = path.join(temp, "stall", "file.bin");
		try {
			const started = Date.now();
			await expect(
				download(`http://127.0.0.1:${port}/x`, dest, "0".repeat(64), {
					label: "stalled",
					log: () => {},
					idleTimeoutMs: 300,
				}),
			).rejects.toThrow(/no data for/);
			expect(Date.now() - started).toBeLessThan(5000);
			expect(fs.readdirSync(path.dirname(dest))).toEqual([]);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	}, 20_000);
});

describe("M7: elan is never left to download an unpinned toolchain", () => {
	async function fakeLean(): Promise<{ lean: unknown; elanHome: string }> {
		const elanHome = fs.mkdtempSync(path.join(temp, "elan-"));
		return {
			elanHome,
			lean: {
				elanHome,
				env: {},
				lake: "lake",
				lean: "lean",
				toolchain: "leanprover/lean4:v4.35.0",
				leanVersion: "4.35.0",
				source: "ompdesk",
			},
		};
	}

	function project(toolchain: string | null, lakefile = 'name = "p"\n[[lean_lib]]\nname = "P"\n'): string {
		const dir = fs.mkdtempSync(path.join(temp, "proj-"));
		fs.writeFileSync(path.join(dir, "lakefile.toml"), lakefile);
		if (toolchain !== null) fs.writeFileSync(path.join(dir, "lean-toolchain"), `${toolchain}\n`);
		return dir;
	}

	it("makes a project that names another, uninstalled toolchain UNAVAILABLE, with and without OMPDESK_FORMAL_OFFLINE", async () => {
		const { guardProjectToolchain } = await lib("lean-env");
		const { Unavailable } = await lib("proc");
		const { lean } = await fakeLean();
		for (const env of [{}, { OMPDESK_FORMAL_OFFLINE: "1" }]) {
			let error: unknown;
			try {
				guardProjectToolchain(project("leanprover/lean4:v4.2.9"), lean, env);
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(Unavailable);
			expect((error as Error).message).toContain("leanprover/lean4:v4.2.9");
			expect((error as Error).message).toMatch(/install it yourself/i);
		}
		let offline = "";
		try {
			guardProjectToolchain(project("v4.2.9"), lean, { OMPDESK_FORMAL_OFFLINE: "1" });
		} catch (caught) {
			offline = (caught as Error).message;
		}
		expect(offline).toContain("OMPDESK_FORMAL_OFFLINE=1");
	});

	it("lets the pinned toolchain, no lean-toolchain file, and an already installed other toolchain through", async () => {
		const { guardProjectToolchain, toolchainDirName } = await lib("lean-env");
		const { lean, elanHome } = await fakeLean();
		expect(() => guardProjectToolchain(project("leanprover/lean4:v4.35.0"), lean, {})).not.toThrow();
		expect(() => guardProjectToolchain(project("v4.35.0"), lean, {})).not.toThrow();
		const bare = fs.mkdtempSync(path.join(temp, "bare-"));
		fs.writeFileSync(path.join(bare, "lakefile.toml"), "name = 'p'\n");
		expect(() => guardProjectToolchain(bare, lean, {})).not.toThrow();
		const other = "leanprover/lean4:v4.30.0";
		const bin = path.join(elanHome, "toolchains", toolchainDirName(other), "bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, process.platform === "win32" ? "lake.exe" : "lake"), "");
		expect(() => guardProjectToolchain(project(other), lean, {})).not.toThrow();
	});

	it("reads ELAN_TOOLCHAIN and the nearest lean-toolchain up the tree, as elan does", async () => {
		const { requestedToolchain } = await lib("lean-env");
		const root = fs.mkdtempSync(path.join(temp, "tree-"));
		fs.writeFileSync(path.join(root, "lean-toolchain"), "leanprover/lean4:v4.1.0\n");
		const nested = path.join(root, "a", "b");
		fs.mkdirSync(nested, { recursive: true });
		expect(requestedToolchain(nested, {})?.toolchain).toBe("leanprover/lean4:v4.1.0");
		expect(requestedToolchain(nested, { ELAN_TOOLCHAIN: "stable" })?.toolchain).toBe("stable");
	});

	it("refuses a project that requires git packages while downloads are off and nothing is fetched yet", async () => {
		const { guardProjectToolchain } = await lib("lean-env");
		const { lean } = await fakeLean();
		const needy = project(null, 'name = "p"\n[[require]]\nname = "plausible"\ngit = "https://example.invalid/x"\n');
		expect(() => guardProjectToolchain(needy, lean, {})).not.toThrow();
		expect(() => guardProjectToolchain(needy, lean, { OMPDESK_FORMAL_OFFLINE: "1" })).toThrow(/git/);
		fs.mkdirSync(path.join(needy, ".lake", "packages"), { recursive: true });
		expect(() => guardProjectToolchain(needy, lean, { OMPDESK_FORMAL_OFFLINE: "1" })).not.toThrow();
	});

	it.skipIf(!REAL)(
		"lean-check on a v4.2.9 project is UNAVAILABLE (exit 3) and elan fetches nothing",
		async () => {
			const dir = project("leanprover/lean4:v4.2.9");
			fs.writeFileSync(path.join(dir, "P.lean"), "theorem t : 1 = 1 := rfl\n");
			const before = fs.readdirSync(path.join(CACHE, "elan", "toolchains")).sort();
			const run = await bun("lean-check.ts", [dir], { OMPDESK_FORMAL_OFFLINE: "1" });
			expect(run.code).toBe(3);
			expect(run.out).toContain("UNAVAILABLE");
			expect(run.out).toContain("leanprover/lean4:v4.2.9");
			expect(fs.readdirSync(path.join(CACHE, "elan", "toolchains")).sort()).toEqual(before);
		},
		120_000,
	);
});

describe("M8: a Lean project in the app bundle or a read-only folder is checked on a copy", () => {
	it("recognises the app bundle and a read-only folder, and leaves a normal folder alone", async () => {
		const { needsCopy } = await lib("lean-trust");
		expect(
			needsCopy("/Applications/OMPdesk.app/Contents/Resources/omp-builtin/formal/skills/x/assets/lean-patterns"),
		).toBe(true);
		expect(needsCopy("C:\\Program Files\\OMPdesk\\resources\\omp-builtin\\formal\\skills\\x")).toBe(true);
		expect(needsCopy(fs.mkdtempSync(path.join(temp, "plain-")))).toBe(false);
		if (process.platform !== "win32" && process.getuid?.() !== 0) {
			const readonly = fs.mkdtempSync(path.join(temp, "ro-"));
			fs.chmodSync(readonly, 0o555);
			expect(needsCopy(readonly)).toBe(true);
			fs.chmodSync(readonly, 0o755);
		}
	});

	/**
	 * A folder inside an install's resources, the way both platforms lay one out (`...\\resources\\omp-builtin\\...` on Windows,
	 * `.app/Contents/Resources/omp-builtin/...` on macOS): it is judged by its path, not by permission bits, because
	 * chmod does not make a Windows folder unwritable.
	 */
	function bundleLikeProject(): string {
		const original = path.join(
			fs.mkdtempSync(path.join(temp, "orig-")),
			"OMPdesk",
			"resources",
			"omp-builtin",
			"lean",
		);
		fs.mkdirSync(path.join(original, ".lake"), { recursive: true });
		fs.writeFileSync(path.join(original, "lakefile.toml"), "name = 'p'\n");
		fs.writeFileSync(path.join(original, ".lake", "big"), "x");
		return original;
	}

	async function expectCopy(original: string): Promise<void> {
		const { withBuildableCopy } = await lib("lean-trust");
		const notes: string[] = [];
		let seen = "";
		await withBuildableCopy(
			original,
			(line: string) => notes.push(line),
			async (dir: string) => {
				seen = dir;
				expect(dir).not.toBe(original);
				expect(fs.existsSync(path.join(dir, "lakefile.toml"))).toBe(true);
				expect(fs.existsSync(path.join(dir, ".lake"))).toBe(false);
				fs.writeFileSync(path.join(dir, ".ompdesk-audit.lean"), "");
			},
		);
		expect(fs.existsSync(seen)).toBe(false);
		expect(fs.readdirSync(original).sort()).toEqual([".lake", "lakefile.toml"]);
		expect(notes.join("\n")).toContain("temporary copy");
	}

	it("hands the work a writable copy without .lake of a project inside the install's resources, and removes it afterwards", async () => {
		await expectCopy(bundleLikeProject());
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"also copies a project whose folder is read-only by its permissions",
		async () => {
			const original = fs.mkdtempSync(path.join(temp, "ro-orig-"));
			fs.writeFileSync(path.join(original, "lakefile.toml"), "name = 'p'\n");
			fs.mkdirSync(path.join(original, ".lake"));
			fs.writeFileSync(path.join(original, ".lake", "big"), "x");
			fs.chmodSync(original, 0o555);
			try {
				await expectCopy(original);
			} finally {
				fs.chmodSync(original, 0o755);
			}
		},
	);

	it("tells a folder it cannot write into by trying to write, never by its mode bits", async () => {
		const { needsCopy } = await lib("lean-trust");
		const plain = fs.mkdtempSync(path.join(temp, "plain-write-"));
		expect(needsCopy(plain)).toBe(false);
		// Windows marks a directory read-only without blocking writes in it: that must not read as unwritable.
		if (process.platform === "win32") spawnSync("attrib", ["+R", plain]);
		expect(needsCopy(plain)).toBe(false);
		// A path that does not exist cannot be written into either.
		expect(needsCopy(path.join(plain, "missing", "deeper"))).toBe(true);
		expect(fs.readdirSync(plain)).toEqual([]);
	});

	it.skipIf(!REAL || process.platform === "win32")(
		"lean-check on a read-only copy of the bounded-queue example passes and writes nothing into it",
		async () => {
			const lean = path.join(copyExample("bounded-queue"), "bounded-queue/lean");
			const lockdown = (mode: number): void => {
				for (const entry of fs.readdirSync(lean, { recursive: true, withFileTypes: true })) {
					if (entry.isDirectory()) fs.chmodSync(path.join(entry.parentPath, entry.name), mode);
				}
				fs.chmodSync(lean, mode);
			};
			lockdown(0o555);
			try {
				const run = await bun("lean-check.ts", [lean]);
				expect(run.out).toContain("temporary copy");
				expect(run.out).toContain("PASS");
				expect(run.code).toBe(0);
				expect(fs.existsSync(path.join(lean, ".lake"))).toBe(false);
				expect(fs.existsSync(path.join(lean, ".ompdesk-audit.lean"))).toBe(false);
			} finally {
				lockdown(0o755);
			}
		},
		300_000,
	);
});

describe("the minors", () => {
	it("lean-check and tlc usage problems exit 2, a missing lakefile included", async () => {
		const empty = fs.mkdtempSync(path.join(temp, "nolake-"));
		const run = await bun("lean-check.ts", [empty]);
		expect(run.code).toBe(2);
		expect(run.out).toContain("no lakefile");
		expect((await bun("lean-check.ts", [])).code).toBe(2);
	});

	it("drift counts a new untracked file in a covered folder", async () => {
		const { checkDrift } = await lib("drift");
		const repo = fs.mkdtempSync(path.join(temp, "drift-"));
		const git = (...args: string[]): string =>
			spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
				cwd: repo,
				encoding: "utf8",
			}).stdout.trim();
		fs.mkdirSync(path.join(repo, "src"));
		fs.writeFileSync(path.join(repo, "src/a.ts"), "1\n");
		git("init", "-q");
		git("add", "-A");
		git("commit", "-q", "-m", "x");
		const head = git("rev-parse", "HEAD");
		expect((await checkDrift(repo, ["src"], head)).status).toBe("ok");
		fs.writeFileSync(path.join(repo, "src/new.ts"), "2\n");
		const drift = await checkDrift(repo, ["src"], head);
		expect(drift.status).toBe("drift");
		expect(drift.files).toEqual(["src/new.ts"]);
	});

	it("a matrix run that expects any violation without naming the property draws a warning", async () => {
		const { matrixWarnings, parseMatrix } = await lib("matrix");
		const runs = parseMatrix({
			runs: [
				{ name: "bug", expect: "violation" },
				{ name: "named", expect: "violation", property: "P" },
				{ name: "kind", expect: "invariant" },
			],
		});
		expect(matrixWarnings(runs)).toEqual([
			'run bug expects a violation without naming "property": any violation will pass it',
		]);
	});

	it("two diagrams on one page do not share marker ids", async () => {
		const { renderGraphSvg, parseGraph } = await lib("graph-svg");
		const graph = parseGraph({ nodes: ["a", "b"], edges: [["a", "b"]], highlight: ["a->b"] });
		const one = renderGraphSvg(graph, "one", "fv-F1");
		const two = renderGraphSvg(graph, "two", "fv-F2");
		const ids = (svg: string): string[] => [...svg.matchAll(/ id="([^"]+)"/g)].map(match => match[1] as string);
		expect(ids(one).filter(id => ids(two).includes(id))).toEqual([]);
		for (const id of ids(one)) expect(one).toContain(`#${id}`);
	});

	it("every adapted file carries its attribution line", () => {
		const roots = ["assets/lean-patterns", "assets/lean-template", "scripts/statechart"];
		const files: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.name === ".lake") continue;
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/\.(lean|mjs|tla)$/.test(entry.name)) files.push(full);
			}
		};
		for (const root of roots) walk(path.join(SKILL, root));
		expect(files.length).toBeGreaterThan(10);
		expect(files.filter(file => !/Adapted from/.test(fs.readFileSync(file, "utf8").slice(0, 300)))).toEqual([]);
		const schema = JSON.parse(fs.readFileSync(path.join(SKILL, "assets/findings.schema.json"), "utf8"));
		expect(schema.$comment).toContain("Adapted from opum-ai/proof-skills");
	});
});

describe("Windows: git's warnings and line endings are not drift, and CRLF text parses like LF", () => {
	function repoWithAutocrlf(): { repo: string; git: (...args: string[]) => string } {
		const repo = fs.mkdtempSync(path.join(temp, "crlf-"));
		const git = (...args: string[]): string =>
			spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
				cwd: repo,
				encoding: "utf8",
			}).stdout.trim();
		git("init", "-q");
		// What a Windows checkout has: the working copy is CRLF, the repository LF, and git warns about it on stderr.
		git("config", "core.autocrlf", "true");
		fs.mkdirSync(path.join(repo, "src"));
		return { repo, git };
	}

	const CODE = "export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n";

	it("git() returns standard output only: a warning on stderr is never read as a file name", async () => {
		const { git: gitCall } = await lib("drift");
		const { repo, git } = repoWithAutocrlf();
		fs.writeFileSync(path.join(repo, "src/a.ts"), CODE);
		git("add", "-A");
		git("commit", "-q", "-m", "x");
		fs.writeFileSync(path.join(repo, "src/a.ts"), CODE.replace("return 1", "return 9"));
		const result = await gitCall(repo, ["diff", "--name-only", "HEAD"]);
		expect(result.out).toBe("src/a.ts");
		const noisy = await gitCall(repo, ["-c", "core.safecrlf=warn", "diff", "--name-only", "HEAD"]);
		expect(noisy.out).toBe("src/a.ts");
		expect(noisy.out).not.toContain("warning");
	});

	it("reports exactly the changed covered file under autocrlf, not git's warning text", async () => {
		const { checkDrift } = await lib("drift");
		const { repo, git } = repoWithAutocrlf();
		fs.writeFileSync(path.join(repo, "src/a.ts"), CODE);
		fs.writeFileSync(path.join(repo, "src/b.ts"), CODE);
		git("add", "-A");
		git("commit", "-q", "-m", "x");
		const head = git("rev-parse", "HEAD");
		// LF text in an autocrlf working copy is what makes git warn "LF will be replaced by CRLF" on stderr.
		fs.writeFileSync(path.join(repo, "src/a.ts"), CODE.replace("return 1", "return 9"));
		const drift = await checkDrift(repo, ["src/a.ts", "src/b.ts"], head);
		expect(drift.status).toBe("drift");
		expect(drift.files).toEqual(["src/a.ts"]);
	});

	it("does not call an autocrlf checkout drift: a file, a function and a line range rewritten with CRLF are unchanged", async () => {
		const { checkDrift, hasUncommitted } = await lib("drift");
		const { repo, git } = repoWithAutocrlf();
		fs.writeFileSync(path.join(repo, "src/a.ts"), CODE);
		git("add", "-A");
		git("commit", "-q", "-m", "x");
		const head = git("rev-parse", "HEAD");
		fs.writeFileSync(path.join(repo, "src/a.ts"), CODE.replaceAll("\n", "\r\n"));
		for (const covers of [["src/a.ts"], ["src/a.ts#a"], ["src/a.ts#b"], ["src/a.ts:1-3"], ["src/a.ts:5-7"]]) {
			const drift = await checkDrift(repo, covers, head);
			expect(drift.status, `${covers} ${drift.message}`).toBe("ok");
			expect(await hasUncommitted(repo, covers), `${covers}`).toBe(false);
		}
		// A real change to one function is still drift for that function only.
		fs.writeFileSync(path.join(repo, "src/a.ts"), CODE.replace("return 2", "return 3").replaceAll("\n", "\r\n"));
		expect((await checkDrift(repo, ["src/a.ts#a"], head)).status).toBe("ok");
		expect((await checkDrift(repo, ["src/a.ts#b"], head)).status).toBe("drift");
	});

	it("reads a TLC trace, a graph and a chart written with CRLF line endings the way it reads LF", async () => {
		const lib2 = (await import(/* @vite-ignore */ path.join(SKILL, "scripts/statechart/lib.mjs"))) as {
			parseTraces: (t: string) => unknown;
			parseDot: (t: string) => { nodes: Map<string, unknown> };
			parseMermaid: (t: string) => unknown;
			lf: (t: string) => string;
		};
		const trace = [
			"Error: Invariant Safe is violated.",
			"Error: The behavior up to this point is:",
			"State 1: <Initial predicate>",
			"/\\ x = 0",
			'/\\ y = "a"',
			"",
			"State 2: <Inc line 1, col 1 to line 1, col 9 of module M>",
			"/\\ x = 1",
			'/\\ y = "a"',
			"",
		].join("\n");
		expect(JSON.stringify(lib2.parseTraces(trace.replaceAll("\n", "\r\n")))).toBe(
			JSON.stringify(lib2.parseTraces(trace)),
		);
		const dot = ['1 [label="/\\\\ x = 0",style = filled]', '2 [label="/\\\\ x = 1"]', '1 -> 2 [label="Inc"];'].join(
			"\n",
		);
		expect(lib2.parseDot(dot.replaceAll("\n", "\r\n")).nodes.size).toBe(2);
		const chart = "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Paid : pay\n  %% never X: Idle & Paid -- no\n";
		expect(JSON.stringify(lib2.parseMermaid(chart.replaceAll("\n", "\r\n")))).toBe(
			JSON.stringify(lib2.parseMermaid(chart)),
		);
		expect(lib2.lf("a\r\nb\r\n")).toBe("a\nb\n");
	});

	it("chart-to-tla.mjs writes the same spec from a CRLF chart, into the current folder", () => {
		const dir = fs.mkdtempSync(path.join(temp, "chart-"));
		const chart =
			"stateDiagram-v2\n  state Screen {\n    [*] --> Cart\n    Cart --> Paid : pay\n    --\n    [*] --> NotCharged\n    NotCharged --> Charged : charge\n  }\n  %% never PaidUncharged: Paid & NotCharged -- x\n";
		const run = (name: string, text: string): { code: number | null; err: string } => {
			fs.writeFileSync(path.join(dir, name), text);
			const result = spawnSync(
				"bun",
				[path.join(SKILL, "scripts/statechart/chart-to-tla.mjs"), name, "--module", name.replace(".mmd", "")],
				{ cwd: dir, encoding: "utf8" },
			);
			return { code: result.status, err: result.stderr };
		};
		// Region state names differ by module only in the header: compare the specs after renaming the module.
		const lf = run("Lf.mmd", chart);
		const crlf = run("Crlf.mmd", chart.replaceAll("\n", "\r\n"));
		expect(lf.code, lf.err).toBe(0);
		expect(crlf.code, crlf.err).toBe(0);
		const body = (name: string): string =>
			fs
				.readFileSync(path.join(dir, `${name}.tla`), "utf8")
				.replaceAll(name, "M")
				.replace(/\\\* Generated.*\n/, "")
				.replace(/\\\* statechart.mjs.*\n/, "");
		expect(body("Crlf")).toBe(body("Lf"));
	});

	it("drift says git is missing when git cannot start, not that the sync commit is unknown", async () => {
		const { checkDrift } = await lib("drift");
		const repo = fs.mkdtempSync(path.join(temp, "nogit-"));
		const saved = process.env.PATH;
		process.env.PATH = fs.mkdtempSync(path.join(temp, "empty-path-"));
		try {
			const drift = await checkDrift(repo, ["src/a.ts"], "0123456789abcdef0123456789abcdef01234567");
			expect(drift.status).toBe("no-git");
			expect(drift.message).toContain("git");
		} finally {
			process.env.PATH = saved;
		}
	});

	it("a statechart output folder is replaced although Windows refuses a rename onto it with EPERM", async () => {
		const { moved } = (await import(/* @vite-ignore */ path.join(SKILL, "scripts/statechart/lib.mjs"))) as {
			moved: (from: string, to: string, ...missed: string[]) => boolean;
		};
		const dir = fs.mkdtempSync(path.join(temp, "moved-"));
		const from = path.join(dir, "next");
		const to = path.join(dir, "out");
		fs.mkdirSync(from);
		fs.mkdirSync(to);
		fs.writeFileSync(path.join(to, "old.txt"), "old");
		const real = fs.renameSync;
		const eperm = (a: fs.PathLike, b: fs.PathLike): void => {
			if (fs.existsSync(b))
				throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
			real(a, b);
		};
		fs.renameSync = eperm;
		try {
			expect(moved(from, to, "ENOTEMPTY", "EEXIST")).toBe(false);
			fs.rmSync(to, { recursive: true });
			expect(moved(from, to, "ENOTEMPTY", "EEXIST")).toBe(true);
			// A real permission error on a free target still throws instead of looping.
			fs.renameSync = () => {
				throw Object.assign(new Error("EPERM"), { code: "EPERM" });
			};
			expect(() => moved(to, path.join(dir, "elsewhere"), "ENOTEMPTY", "EEXIST")).toThrow("EPERM");
		} finally {
			fs.renameSync = real;
		}
	});
});
