import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appEntry, assertAppBuilt } from "./e2e-app-entry";

const ROOT = path.resolve(import.meta.dirname, "..");
let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-no-out-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("assertAppBuilt", () => {
	it("names the missing entry and how to build it", () => {
		expect(() => assertAppBuilt({ OMP_GUI_E2E_OUT: dir })).toThrow(/No build:.*bun run build.*bun run check:changed/);
	});

	it("returns the entry once main/index.js exists", () => {
		fs.mkdirSync(path.join(dir, "main"));
		fs.writeFileSync(path.join(dir, "main/index.js"), "");
		expect(assertAppBuilt({ OMP_GUI_E2E_OUT: dir })).toBe(path.join(dir, "main/index.js"));
	});

	it("defaults to out/", () => {
		expect(appEntry({})).toBe(path.resolve("out", "main/index.js"));
	});
});

describe("playwright without a build", () => {
	it("fails the whole run at once and starts no Electron", () => {
		const started = Date.now();
		const run = spawnSync(
			"bunx",
			["playwright", "test", "e2e/smoke.e2e.ts", "--reporter=line", "--output", path.join(dir, "results")],
			{
				cwd: ROOT,
				encoding: "utf8",
				timeout: 60_000,
				env: { ...process.env, OMP_GUI_E2E_OUT: dir, OMP_GUI_WORKERS: "1" },
			},
		);
		const elapsed = Date.now() - started;
		expect(run.status).not.toBe(0);
		expect(`${run.stdout}${run.stderr}`).toContain("No build:");
		// A launched test would take seconds and show the dialog; a refused run is Playwright's startup only.
		expect(elapsed).toBeLessThan(30_000);
		if (process.platform !== "win32") {
			const processes = spawnSync("ps", ["-axo", "command"], { encoding: "utf8" }).stdout;
			expect(processes).not.toContain(dir);
		}
	}, 90_000);
});
