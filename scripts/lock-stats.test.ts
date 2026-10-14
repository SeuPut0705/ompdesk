import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendLockLog, commandKind, type LockLogEntry, readLockLog } from "./lock-log";
import { parseSince, percentile, summarize } from "./lock-stats";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function entry(owner: string, command: string, waitedMs: number, heldMs: number): LockLogEntry {
	return {
		time: new Date().toISOString(),
		owner,
		command,
		kind: commandKind(command),
		cwd: "/x",
		waitedMs,
		heldMs,
		exit: 0,
	};
}

describe("lock log", () => {
	it("classifies locked commands", () => {
		expect(commandKind("bun run gate")).toBe("gate");
		expect(commandKind("bun run build")).toBe("build");
		expect(commandKind("bun run package:mac -- --publish never")).toBe("build");
		expect(commandKind("bunx playwright test e2e/smoke.e2e.ts --output /tmp/x")).toBe("playwright");
		expect(commandKind("bunx vitest run --maxWorkers=4")).toBe("vitest");
		expect(commandKind("bun run test")).toBe("vitest");
		expect(commandKind("sleep 5")).toBe("other");
	});

	it("appends entries and trims the log past 5000 lines", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-lock-log-"));
		dirs.push(dir);
		const file = path.join(dir, "build.log");
		appendLockLog(entry("a", "bun run build", 1, 2), file);
		expect(readLockLog(file)).toHaveLength(1);
		fs.appendFileSync(file, "{cut short\n");
		const line = `${JSON.stringify(entry("a", "bun run build", 1, 2))}\n`;
		fs.appendFileSync(file, line.repeat(5_100));
		appendLockLog(entry("last", "bun run gate", 3, 4), file);
		const kept = readLockLog(file);
		expect(kept).toHaveLength(4_000);
		expect(kept.at(-1)?.owner).toBe("last");
	});
});

describe("lock stats", () => {
	it("parses --since windows", () => {
		expect(parseSince("90s")).toBe(90_000);
		expect(parseSince("2h")).toBe(7_200_000);
		expect(parseSince("1d")).toBe(86_400_000);
		expect(parseSince("all")).toBe(Number.POSITIVE_INFINITY);
		expect(() => parseSince("2 hours")).toThrow();
	});

	it("takes nearest-rank percentiles", () => {
		const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		expect(percentile(values, 50)).toBe(5);
		expect(percentile(values, 90)).toBe(9);
		expect(percentile([], 90)).toBe(0);
	});

	it("totals wait and hold per owner, longest wait first", () => {
		const rows = summarize(
			[
				entry("a", "bun run build", 1_000, 10_000),
				entry("b", "bunx playwright test", 30_000, 60_000),
				entry("a", "bunx vitest run", 3_000, 20_000),
			],
			e => e.owner,
		);
		expect(rows.map(row => [row.key, row.runs, row.waitTotal, row.holdTotal])).toEqual([
			["b", 1, 30_000, 60_000],
			["a", 2, 4_000, 30_000],
		]);
		expect(rows[1]?.waitP90).toBe(3_000);
	});
});
