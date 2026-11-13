import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPTS = fileURLToPath(new URL(".", import.meta.url));
const MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));

describe("lint-surfaces --only", () => {
	let repo = "";
	const run = (...args) =>
		spawnSync("node", ["scripts/lint-surfaces.mjs", ...args], { cwd: repo, encoding: "utf8", timeout: 120_000 });
	const write = (file, text) => {
		mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
		writeFileSync(path.join(repo, file), text);
	};

	// A repository holding the lints and two renderer files, so a violation outside `--only` cannot be seen by chance.
	beforeEach(() => {
		repo = mkdtempSync(path.join(tmpdir(), "lint-surfaces-"));
		mkdirSync(path.join(repo, "scripts"));
		for (const file of readdirSync(SCRIPTS))
			if (/^lint-[^/]+\.mjs$/.test(file) && !file.endsWith(".test.mjs"))
				copyFileSync(path.join(SCRIPTS, file), path.join(repo, "scripts", file));
		write("scripts/lint-duplicate-rules-allow.json", "[]\n");
		symlinkSync(MODULES, path.join(repo, "node_modules"), "junction");
		for (const dir of ["src/main", "src/shared", "resources/gui-bridge"])
			mkdirSync(path.join(repo, dir), { recursive: true });
		write("src/renderer/Bad.tsx", 'export const a = <p className="text-[12px]">x</p>;\n');
		write("src/renderer/Good.tsx", 'export const a = <p className="text-sc-body">x</p>;\n');
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	it("finds a violation in the whole tree without it, and only in a named file with it", () => {
		const all = run();
		expect(all.status).toBe(1);
		expect(all.stderr).toContain("Bad.tsx:1  raw pixel font class");
		const bad = run("--only", "src/renderer/Bad.tsx");
		expect(bad.status).toBe(1);
		expect(bad.stderr).toContain("Bad.tsx:1  raw pixel font class");
		const good = run("--only", "src/renderer/Good.tsx", "src/renderer/gone-since.tsx");
		expect(good.status).toBe(0);
		expect(good.stdout).toContain("surface policy: clean");
	});

	it("runs the duplicate rules on the whole tree whichever files it names", () => {
		const rule = "export const SAME = /^same-rule-[a-z]+$/;\n";
		write("src/main/a.ts", rule);
		write("src/shared/b.ts", rule);
		const result = run("--only", "src/renderer/Good.tsx");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("duplicate rule");
		expect(run("--only").status).toBe(1);
	});
});
