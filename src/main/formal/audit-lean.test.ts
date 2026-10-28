/**
 * Lean trust audit holes found by the audit: each case is a false PASS (or a wrong name) on the code it was written
 * against. The cases that need the real Lean toolchain run with `OMP_GUI_REAL_FORMAL=1` and
 * `OMPDESK_FORMAL_CACHE` pointing at a cache that has Lean 4.35.0. One scaffold is built once and copied (with its
 * `.lake`) per case, so a case costs one `lake build` of what it changed.
 *
 * `FORMAL_SKILL_DIR` points the cases at another copy of the skill (a `git archive` of an older commit).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SKILL =
	process.env.FORMAL_SKILL_DIR ??
	path.join(__dirname, "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify");
const REAL = process.env.OMP_GUI_REAL_FORMAL === "1";
const CACHE = process.env.OMPDESK_FORMAL_CACHE ?? path.join(os.tmpdir(), "formal-cache");
const EXE = process.platform === "win32" ? ".exe" : "";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "formal-audit-lean-"));
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

interface Checked extends Ran {
	// biome-ignore lint/suspicious/noExplicitAny: the JSON report of lean-check.
	json?: any;
}

async function leanCheck(dir: string, args: string[] = []): Promise<Checked> {
	const ran = await bun("lean-check.ts", [dir, "--json", ...args]);
	const start = ran.out.indexOf("{");
	let json: unknown;
	if (start >= 0) {
		try {
			json = JSON.parse(ran.out.slice(start));
		} catch {
			json = undefined;
		}
	}
	return { ...ran, json };
}

const toolchainBin = (): string => path.join(CACHE, "elan", "toolchains", "leanprover--lean4---v4.35.0", "bin");

function lake(dir: string, args: string[]): Promise<Ran> {
	const { promise, resolve } = Promise.withResolvers<Ran>();
	execFile(
		path.join(toolchainBin(), `lake${EXE}`),
		args,
		{
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, PATH: `${toolchainBin()}${path.delimiter}${process.env.PATH}` },
		},
		(error, stdout, stderr) =>
			resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out: `${stdout}${stderr}` }),
	);
	return promise;
}

const LAKEFILE = (extra = ""): string =>
	`name = "atk"\nversion = "0.1.0"\ndefaultTargets = ["Atk"]\n\n[[lean_lib]]\nname = "Atk"\n${extra}`;

describe("Lean trust audit: holes found by the audit", () => {
	let base = "";
	const write = (dir: string, file: string, text: string): void => {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), text);
	};
	const variant = (edit: (dir: string) => void): string => {
		const dir = fs.mkdtempSync(path.join(temp, "case-"));
		fs.cpSync(base, dir, { recursive: true });
		edit(dir);
		return dir;
	};

	beforeAll(async () => {
		if (!REAL) return;
		base = path.join(temp, "base");
		const created = await bun("new-lean.ts", [base, "Atk"]);
		expect(created.code, created.out).toBe(0);
		write(base, "Atk/Facts.lean", "namespace Atk\ntheorem two_two : 2 + 2 = 4 := by decide\nend Atk\n");
		write(base, "Atk.lean", `${fs.readFileSync(path.join(base, "Atk.lean"), "utf8")}import Atk.Facts\n`);
		const first = await leanCheck(base);
		expect(first.code, first.out).toBe(0);
	}, 600_000);

	describe("1: every module of every library is built and audited", () => {
		it.skipIf(!REAL)(
			"fails a file that the library root does not import",
			async () => {
				const dir = variant(d => write(d, "Atk/Orphan.lean", "theorem orphan : 2 + 2 = 5 := by decide\n"));
				const run = await leanCheck(dir);
				expect(run.code, run.out).toBe(1);
				expect(run.json.detail).toContain("Atk/Orphan.lean");
			},
			300_000,
		);

		it.skipIf(!REAL)(
			"fails a library that is not a default target, even with an older .olean of it on disk",
			async () => {
				const dir = variant(d => {
					write(d, "lakefile.toml", `${LAKEFILE()}\n[[lean_lib]]\nname = "Side"\n`);
					write(d, "Side.lean", "theorem side : 2 + 2 = 4 := by decide\n");
				});
				expect((await lake(dir, ["build", "Side"])).code).toBe(0);
				write(dir, "Side.lean", "theorem side : 2 + 2 = 5 := by decide\n");
				const run = await leanCheck(dir);
				expect(run.code, run.out).toBe(1);
				expect(run.json.detail).toContain("Side.lean");
			},
			300_000,
		);

		it.skipIf(!REAL)(
			"builds and audits a library whose roots are not its name, and modules that its globs name",
			async () => {
				const dir = variant(d => {
					write(
						d,
						"lakefile.toml",
						`${LAKEFILE()}\n[[lean_lib]]\nname = "Pkg"\nroots = ["Real"]\nglobs = ["Real", "Real.*"]\n`,
					);
					write(d, "Real.lean", "theorem real_ok : 1 + 1 = 2 := rfl\n");
					write(d, "Real/Hidden.lean", "theorem hidden : 1 + 1 = 3 := by decide\n");
				});
				const run = await leanCheck(dir);
				expect(run.code, run.out).toBe(1);
				expect(run.json.detail).toContain("Real/Hidden.lean");
				fs.rmSync(path.join(dir, "Real/Hidden.lean"));
				const ok = await leanCheck(dir);
				expect(ok.code, ok.out).toBe(0);
				expect(ok.json.theorems.map((t: { name: string }) => t.name)).toContain("real_ok");
			},
			300_000,
		);

		it.skipIf(!REAL)(
			"a mutation of a non-default library is DETECTED, not answered from the copied .olean",
			async () => {
				const dir = variant(d => {
					write(d, "lakefile.toml", `${LAKEFILE()}\n[[lean_lib]]\nname = "Side"\n`);
					write(d, "Side.lean", "theorem side_ok : 2 + 2 = 4 := by decide\n");
					write(
						d,
						"mutations.json",
						JSON.stringify({
							checker: { kind: "lean", project: "." },
							properties: ["side_ok"],
							mutations: [
								{
									name: "wrong-sum",
									why: "the sum is wrong",
									file: "Side.lean",
									search: "2 + 2 = 4",
									replace: "2 + 2 = 5",
									breaks: "side_ok",
								},
							],
						}),
					);
				});
				const ok = await leanCheck(dir);
				expect(ok.code, ok.out).toBe(0);
				const run = await bun("mutate.ts", [path.join(dir, "Side.lean"), path.join(dir, "mutations.json")]);
				expect(run.out).toContain("DETECTED");
				expect(run.code, run.out).toBe(0);
			},
			600_000,
		);
	});

	describe("2: #exit hides what follows it", () => {
		it.skipIf(!REAL)(
			"fails a theorem written after #exit",
			async () => {
				const dir = variant(d =>
					write(d, "Atk/Facts.lean", "theorem fine : 1 = 1 := rfl\n#exit\ntheorem bad : 2 + 2 = 5 := by decide\n"),
				);
				const run = await leanCheck(dir);
				expect(run.code, run.out).toBe(1);
				expect(
					run.json.findings.some((f: { kind: string; blocking: boolean }) => f.kind === "exit" && f.blocking),
				).toBe(true);
			},
			300_000,
		);

		it("finds #exit in a source scan, not in a comment", async () => {
			const { scanSource } = await lib("lean-trust");
			expect(scanSource("A.lean", "theorem a : True := trivial\n  #exit\n", false)).toMatchObject([
				{ kind: "exit", line: 2, blocking: true },
			]);
			expect(scanSource("A.lean", "-- #exit\n/- #exit -/\n", false)).toEqual([]);
		});
	});

	describe("3: the kernel is re-checked, and skipping its check is refused", () => {
		const evil = (name: string, option: string): string =>
			[
				"import Lean",
				"open Lean Elab Command",
				option,
				`run_cmd liftCoreM <| addDecl <| .thmDecl { name := \`${name}, levelParams := [], type := mkConst \`\`False, value := mkConst \`\`False }`,
				"",
			].join("\n");

		it.skipIf(!REAL)(
			"fails a theorem of False added with debug.skipKernelTC, and names the option",
			async () => {
				const dir = variant(d => write(d, "Atk/Evil.lean", evil("Atk.evil", "set_option debug.skipKernelTC true")));
				const run = await leanCheck(dir);
				expect(run.code, run.out).toBe(1);
				expect(run.json.detail).toContain("skipKernelTC");
			},
			300_000,
		);

		it.skipIf(!REAL)(
			"fails the same theorem when the option is set without spelling it, by the toolchain's leanchecker",
			async () => {
				const sneaky = [
					"import Lean",
					"open Lean Elab Command",
					'def skipName : Name := Name.mkStr (Name.mkSimple "debug") ("skip" ++ "KernelTC")',
					"run_cmd liftCoreM <| withOptions (fun o => o.setBool skipName true) <|",
					"  addDecl <| .thmDecl { name := `Atk.evil, levelParams := [], type := mkConst ``False, value := mkConst ``False }",
					"",
				].join("\n");
				const dir = variant(d => write(d, "Atk/Evil.lean", sneaky));
				const run = await leanCheck(dir);
				expect(run.code, run.out).toBe(1);
				expect(run.json.status).toBe("fail");
				expect(run.json.detail).toContain("Atk.evil");
				expect(run.json.violated).toContain("evil");
			},
			300_000,
		);

		it("finds debug.skipKernelTC in a source scan, not in a comment", async () => {
			const { scanSource } = await lib("lean-trust");
			expect(scanSource("A.lean", "set_option debug.skipKernelTC true in\n", false)).toMatchObject([
				{ kind: "skipKernelTC", line: 1, blocking: true },
			]);
			expect(scanSource("A.lean", "-- debug.skipKernelTC\n", false)).toEqual([]);
		});

		it.skipIf(process.platform === "win32")("a toolchain without leanchecker is a note, not a failure", async () => {
			const { runKernelCheck } = await lib("lean-trust");
			const prefix = fs.mkdtempSync(path.join(temp, "no-checker-"));
			fs.mkdirSync(path.join(prefix, "bin"));
			const fake = path.join(prefix, "lake");
			fs.writeFileSync(fake, `#!/bin/sh\necho ${JSON.stringify(prefix)}\n`);
			fs.chmodSync(fake, 0o755);
			const result = await runKernelCheck(prefix, { lake: fake, env: process.env }, ["Atk"]);
			expect(result.status).toBe("missing");
			expect(result.detail).toContain("leanchecker");
		});
	});

	describe("4: --allow-native does not make a lying implementation harmless", () => {
		const LYING = [
			"def real (n : Nat) : Nat := n + 1",
			"@[implemented_by real] def lie (n : Nat) : Nat := n",
			"theorem lie_zero : lie 0 = 1 := by native_decide",
			"",
		].join("\n");

		it.skipIf(!REAL)(
			"fails a false theorem proved by native_decide through @[implemented_by] under --allow-native",
			async () => {
				const dir = variant(d => write(d, "Atk/Lie.lean", LYING));
				const run = await leanCheck(dir, ["--allow-native"]);
				expect(run.code, run.out).toBe(1);
				expect(
					run.json.findings.some(
						(f: { kind: string; blocking: boolean }) => f.kind === "implemented_by" && f.blocking,
					),
				).toBe(true);
			},
			300_000,
		);

		it("keeps implemented_by and extern advisory while native_decide is refused, blocking once it is allowed", async () => {
			const { scanSource } = await lib("lean-trust");
			const text =
				'@[implemented_by foo] def a := 1\n@[extern "c_b"] def b := 2\nattribute [implemented_by foo] c\n';
			for (const [allow, blocking] of [
				[false, false],
				[true, true],
			] as const) {
				const found = scanSource("A.lean", text, allow);
				expect(found.map((f: { kind: string }) => f.kind)).toEqual(["implemented_by", "extern", "implemented_by"]);
				expect(found.every((f: { blocking: boolean }) => f.blocking === blocking)).toBe(true);
			}
		});

		it.skipIf(!REAL)(
			"bv_decide's native axiom is flagged NATIVE and passes only with --allow-native",
			async () => {
				const dir = variant(d =>
					write(
						d,
						"Atk/Bv.lean",
						"import Std.Tactic.BVDecide\ntheorem and_comm8 (x y : BitVec 8) : x &&& y = y &&& x := by bv_decide\n",
					),
				);
				const refused = await leanCheck(dir);
				expect(refused.code, refused.out).toBe(1);
				expect(refused.json.theorems.find((t: { name: string }) => t.name === "and_comm8")?.flag).toBe("NATIVE");
				const allowed = await leanCheck(dir, ["--allow-native"]);
				expect(allowed.code, allowed.out).toBe(0);
			},
			300_000,
		);
	});

	describe("5: user declarations are not dropped by name, and every axiom spelling is found", () => {
		it("finds axioms behind attributes and modifiers", async () => {
			const { scanSource } = await lib("lean-trust");
			for (const line of [
				"@[simp] axiom a : 1 = 2",
				"@[simp] private axiom a : 1 = 2",
				"noncomputable axiom a : Nat",
				"protected unsafe axiom a : Nat",
				"  axiom a : False",
			]) {
				const axioms = scanSource("A.lean", `${line}\n`, false).filter((f: { kind: string }) => f.kind === "axiom");
				expect(axioms, line).toMatchObject([{ kind: "axiom", blocking: true }]);
			}
			expect(scanSource("A.lean", "theorem axiomatic : True := trivial\n", false)).toEqual([]);
		});

		it.skipIf(!REAL)(
			"fails an axiom that is named like a generated declaration (inj) and was made by a macro",
			async () => {
				const dir = variant(d =>
					write(
						d,
						"Atk/Gen.lean",
						[
							"set_option hygiene false in",
							'macro "mk_ax" : command => `(axiom inj : False)',
							"mk_ax",
							"theorem eq_1 : False := inj",
							"",
						].join("\n"),
					),
				);
				const run = await leanCheck(dir);
				expect(run.code, run.out).toBe(1);
				expect(run.json.detail).toContain("AXIOM:inj");
				expect(run.json.violated).toContain("eq_1");
			},
			300_000,
		);
	});

	describe("6: nothing audited is not a pass", () => {
		it.skipIf(!REAL)(
			"a --module that matches no module is a usage error",
			async () => {
				const run = await leanCheck(base, ["--module", "atk"]);
				expect(run.code, run.out).toBe(2);
				expect(run.out).toContain("atk");
			},
			300_000,
		);

		it.skipIf(!REAL)(
			"a library whose root is empty audits nothing and fails",
			async () => {
				const dir = variant(d => {
					fs.rmSync(path.join(d, "Atk"), { recursive: true });
					write(d, "Atk.lean", "");
				});
				const run = await leanCheck(dir);
				expect(run.code, run.out).toBe(1);
				expect(run.json.detail).toContain("nothing audited");
			},
			300_000,
		);
	});

	describe("7: namespaces survive noncomputable sections and mutual blocks", () => {
		it("qualifies a declaration after `noncomputable section ... end` and `mutual ... end` inside a namespace", async () => {
			const { enclosingDeclaration } = await lib("lean-trust");
			const source = [
				"namespace Q",
				"noncomputable section",
				"def a := 1",
				"end",
				"mutual",
				"def m1 := 1",
				"def m2 := 2",
				"end",
				"def b := 2",
				"end Q",
			].join("\n");
			expect(enclosingDeclaration(source, 3)).toBe("Q.a");
			expect(enclosingDeclaration(source, 7)).toBe("Q.m2");
			expect(enclosingDeclaration(source, 9)).toBe("Q.b");
		});
	});

	describe("8: the docs say what bv_decide does on the pinned Lean", () => {
		it("name the axiom bv_decide adds (not ofReduceBool) and what lean-check reports", () => {
			const proving = fs.readFileSync(path.join(SKILL, "references/lean-proving.md"), "utf8");
			const pitfalls = fs.readFileSync(path.join(SKILL, "references/lean-pitfalls.md"), "utf8");
			expect(proving).not.toContain("adds the `ofReduceBool` axiom");
			for (const doc of [proving, pitfalls]) {
				expect(doc).toContain("._native.bv_decide.ax_");
				expect(doc).toContain("NATIVE");
			}
		});
	});
});
