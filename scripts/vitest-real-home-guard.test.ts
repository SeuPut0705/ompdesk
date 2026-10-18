/**
 * The setup-file guard (vitest-real-home-guard.ts): a write under the developer's real omp or OMPdesk
 * state throws, whatever HOME a test fakes, and a temp dir stays writable.
 *
 * The probes sit in a directory that does not exist (`__ompdesk_guard_probe__/…`, no `recursive`), so a
 * missing guard shows up as an ENOENT instead of a file landing in the real home.
 */
import * as fs from "node:fs";
import { appendFile, copyFile, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {} from "./vitest-real-home-guard";

// Only the setup file (vitest.setup.ts) installs the guard: importing the module here would hide a setup that lost it.
const ALLOW_REAL_HOME_ENV = "OMP_GUI_ALLOW_REAL_HOME";
const takeRealHomeViolations = (): string[] => globalThis.ompdeskRealHomeWriteGuard?.violations.splice(0) ?? [];
const THIS_FILE = fileURLToPath(import.meta.url);
const realHome = userInfo().homedir;
const GUARD = /real-home guard/;
const probe = (...parts: string[]) => join(realHome, ...parts, "__ompdesk_guard_probe__", "nested", "file");

const PROTECTED: Array<[string, string]> = [
	["~/.omp", probe(".omp")],
	["~/.pi", probe(".pi")],
	["~/.config/omp", probe(".config", "omp")],
	["~/Library/Application Support/ompdesk", probe("Library", "Application Support", "ompdesk")],
	["%APPDATA%\\ompdesk", probe("AppData", "Roaming", "ompdesk")],
];

const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

afterEach(() => {
	for (const [key, value] of Object.entries(savedHome)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	delete process.env[ALLOW_REAL_HOME_ENV];
	// This file refuses writes on purpose; the guard's own afterEach must not fail the test for them.
	takeRealHomeViolations();
});

describe("real-home write guard", () => {
	it("is installed by the setup file", () => {
		expect(globalThis.ompdeskRealHomeWriteGuard).toBeDefined();
	});

	it.each(PROTECTED)("refuses promise writes under %s", async (_label, target) => {
		await expect(writeFile(target, "x")).rejects.toThrow(GUARD);
		await expect(appendFile(target, "x")).rejects.toThrow(GUARD);
		await expect(mkdir(target, { recursive: true })).rejects.toThrow(GUARD);
		await expect(rm(target, { force: true })).rejects.toThrow(GUARD);
		await expect(copyFile(THIS_FILE, target)).rejects.toThrow(GUARD);
		await expect(rename(THIS_FILE, target)).rejects.toThrow(GUARD);
		await expect(open(target, "w")).rejects.toThrow(GUARD);
		await expect(open(target, "a+")).rejects.toThrow(GUARD);
	});

	it.each(PROTECTED)("refuses sync, callback and stream writes under %s", (_label, target) => {
		expect(() => fs.writeFileSync(target, "x")).toThrow(GUARD);
		expect(() => fs.appendFileSync(target, "x")).toThrow(GUARD);
		expect(() => fs.mkdirSync(target, { recursive: true })).toThrow(GUARD);
		expect(() => fs.rmSync(target, { force: true })).toThrow(GUARD);
		expect(() => fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT)).toThrow(GUARD);
		expect(() => fs.writeFile(target, "x", () => {})).toThrow(GUARD);
		expect(() => fs.mkdir(target, () => {})).toThrow(GUARD);
		expect(() => fs.createWriteStream(target)).toThrow(GUARD);
	});

	it("still lets a read open the real home (only writes are refused)", async () => {
		await expect(open(probe(".omp"), "r")).rejects.toThrow(/ENOENT/);
		expect(() => fs.openSync(probe(".omp"), "r")).toThrow(/ENOENT/);
	});

	it("takes the real home from the passwd entry, not from a faked HOME", async () => {
		const faked = fs.mkdtempSync(join(tmpdir(), "ompdesk-fake-home-"));
		process.env.HOME = faked;
		process.env.USERPROFILE = faked;
		await expect(writeFile(probe(".omp"), "x")).rejects.toThrow(GUARD);
		try {
			await writeFile(join(faked, "ok"), "fine");
			expect(fs.readFileSync(join(faked, "ok"), "utf8")).toBe("fine");
		} finally {
			await rm(faked, { recursive: true, force: true });
		}
	});

	it("leaves the temp dir writable", async () => {
		const dir = fs.mkdtempSync(join(tmpdir(), "ompdesk-guard-"));
		try {
			const file = join(dir, "nested", "file");
			await mkdir(join(dir, "nested"));
			await writeFile(file, "ok");
			await appendFile(file, "!");
			expect(fs.readFileSync(file, "utf8")).toBe("ok!");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("does not mistake a sibling of a protected folder for it", async () => {
		await expect(writeFile(join(realHome, ".omp-sibling", "__ompdesk_guard_probe__", "f"), "x")).rejects.toThrow(
			/ENOENT/,
		);
	});

	it("leaves the agent worktrees under ~/.omp/wt alone (the repo itself may live there)", async () => {
		await expect(writeFile(probe(".omp", "wt"), "x")).rejects.toThrow(/ENOENT/);
	});

	it("records a refused write even when the caller swallows the error, for afterEach to fail on", async () => {
		takeRealHomeViolations();
		await writeFile(probe(".omp"), "x").catch(() => undefined);
		const taken = takeRealHomeViolations();
		expect(taken).toHaveLength(1);
		expect(taken[0]).toMatch(GUARD);
	});

	it("is off when the real-omp opt-out is set", async () => {
		process.env[ALLOW_REAL_HOME_ENV] = "1";
		await expect(writeFile(probe(".omp"), "x")).rejects.toThrow(/ENOENT/);
	});
});
