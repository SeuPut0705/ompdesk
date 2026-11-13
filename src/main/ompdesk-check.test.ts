/**
 * `ompdesk check` against a real Playwright run (native/ompdesk/crates/checks; control-tools › Heavy slots and
 * `ompdesk check`): what it runs again and what it reuses, by the results the run's own reporter recorded.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { binaryFile, ensureNative, stagedDir } from "../../scripts/build-native";

const REPO = resolve(import.meta.dirname, "../..");
const PLAYWRIGHT = join(REPO, "node_modules", ".bin", "playwright");
let dir: string;
let project: string;

beforeAll(() => {
	ensureNative();
}, 900_000);
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompdesk-check-"));
	project = join(dir, "project");
	mkdirSync(join(project, "tests"), { recursive: true });
	symlinkSync(join(REPO, "node_modules"), join(project, "node_modules"));
	writeFileSync(join(project, "playwright.config.cjs"), 'module.exports = { testDir: "tests", reporter: "list" };\n');
	writeFileSync(join(project, "helper.cjs"), "module.exports = { answer: 42 };\n");
	writeFileSync(
		join(project, "tests", "a.spec.cjs"),
		'const { test, expect } = require("@playwright/test");\ntest("steady", () => expect(require("../helper.cjs").answer).toBe(42));\ntest.describe("group", () => { test("inner", () => expect(1).toBe(1)); });\n',
	);
	writeFileSync(
		join(project, "tests", "b.spec.cjs"),
		'const { test, expect } = require("@playwright/test");\ntest("breaks", () => expect(1).toBe(2));\n',
	);
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function check(...flags: string[]) {
	const result = spawnSync(
		join(stagedDir(), binaryFile("ompdesk")),
		["check", "--light", ...flags, "--", PLAYWRIGHT, "test", "--config", "playwright.config.cjs"],
		{
			cwd: project,
			encoding: "utf8",
			timeout: 120_000,
			env: {
				...process.env,
				OMPDESK_CHECKS_DIR: join(dir, "store"),
				OMPDESK_HEAVY_DIR: join(dir, "heavy"),
				OMPDESK_HEAVY_HELD: "",
				OMPDESK_CHECK_RUN: "",
			},
		},
	);
	const output = `${result.stdout}${result.stderr}`;
	const verdict = /verdict (\S+verdict\.txt)/.exec(output)?.[1];
	return { status: result.status, output, verdict: verdict ? readFileSync(verdict, "utf8") : "" };
}

// Windows starts node_modules/.bin/playwright as playwright.cmd through cmd.exe, which this spawn does not resolve; the
// rules under test are the same there (the Rust tests of the crate run on every OS).
describe.skipIf(process.platform === "win32")("ompdesk check with Playwright", () => {
	it("reruns only what failed while nothing changed, and every reused pass names its run", () => {
		const first = check();
		expect(first.status).toBe(1);
		expect(first.output).toContain("full: no earlier run of this check to reuse");
		expect(first.verdict).toMatch(/failed +b\.spec\.cjs › breaks — run now/);

		const again = check();
		expect(again.status).toBe(1);
		expect(again.output).toMatch(/narrowed: the inputs are the same as run \S+ .*: 2 passes reused/);
		// Playwright itself ran one test: the two passes were left out by name.
		expect(again.output).toMatch(/1 failed\b/);
		expect(again.output).not.toMatch(/\b[1-9] passed\b/);
		expect(again.verdict).toMatch(
			/passed +a\.spec\.cjs › steady — reused from run \S+ \(no commit, .*\), log \S+\/log/,
		);
		expect(again.verdict).toMatch(/passed +a\.spec\.cjs › group › inner — reused from run/);
		expect(again.verdict).toMatch(/failed +b\.spec\.cjs › breaks — run now/);
	}, 300_000);

	it("runs only a changed test file, and everything once anything else changed", () => {
		expect(check().status).toBe(1);
		writeFileSync(
			join(project, "tests", "b.spec.cjs"),
			'const { test, expect } = require("@playwright/test");\ntest("breaks", () => expect(2).toBe(2));\n',
		);
		const testEdited = check();
		expect(testEdited.status).toBe(0);
		expect(testEdited.output).toContain("only test files changed: tests/b.spec.cjs run in full");
		expect(testEdited.output).toMatch(/\b1 passed\b/);
		expect(testEdited.verdict).toMatch(/passed +a\.spec\.cjs › steady — reused from run/);

		appendFileSync(join(project, "helper.cjs"), "// a change no test file shows\n");
		const helperEdited = check();
		expect(helperEdited.status).toBe(0);
		expect(helperEdited.output).toContain("full: files other than tests changed");
		expect(helperEdited.output).toMatch(/\b3 passed\b/);

		const unchanged = check();
		expect(unchanged.status).toBe(0);
		expect(unchanged.output).toMatch(/reused: .*which passed: nothing runs/);
	}, 300_000);
});
