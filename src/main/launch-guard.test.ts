import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markLaunchStable, startLaunchGuard } from "./launch-guard";
import { CRASH_LOOP_WINDOW_MS } from "./launch-guard-core";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "launch-guard-"));
	file = join(dir, "launch-history.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const SECOND = 1000;

describe("crash-loop guard", () => {
	it("starts in safe mode after three launches in a row ended before they became stable", () => {
		const t0 = 1_800_000_000_000;
		expect(startLaunchGuard(file, t0).safeMode).toBe(false);
		expect(startLaunchGuard(file, t0 + 5 * SECOND).safeMode).toBe(false);
		expect(startLaunchGuard(file, t0 + 10 * SECOND).safeMode).toBe(false);
		expect(startLaunchGuard(file, t0 + 15 * SECOND).safeMode).toBe(true);
	});

	it("a safe-mode launch that stays up ends safe mode for the next one", () => {
		const t0 = 1_800_000_000_000;
		for (let i = 0; i < 3; i++) startLaunchGuard(file, t0 + i * SECOND);
		expect(startLaunchGuard(file, t0 + 3 * SECOND).safeMode).toBe(true);
		markLaunchStable();
		expect(startLaunchGuard(file, t0 + 60 * SECOND).safeMode).toBe(false);
	});

	it("a stable or cleanly quit launch among them is no loop", () => {
		const t0 = 1_800_000_000_000;
		startLaunchGuard(file, t0);
		startLaunchGuard(file, t0 + SECOND);
		markLaunchStable();
		startLaunchGuard(file, t0 + 2 * SECOND);
		expect(startLaunchGuard(file, t0 + 3 * SECOND).safeMode).toBe(false);
	});

	it("launches that ended long ago are no loop", () => {
		const t0 = 1_800_000_000_000;
		for (let i = 0; i < 3; i++) startLaunchGuard(file, t0 + i * SECOND);
		expect(startLaunchGuard(file, t0 + 2 * SECOND + CRASH_LOOP_WINDOW_MS + SECOND).safeMode).toBe(false);
	});

	it("an unreadable history never blocks a start", () => {
		writeFileSync(file, "{not json");
		expect(startLaunchGuard(file, 1_800_000_000_000).safeMode).toBe(false);
		expect(startLaunchGuard(join(dir, "missing", "deeper", "h.json"), 1_800_000_000_000).safeMode).toBe(false);
	});
});
