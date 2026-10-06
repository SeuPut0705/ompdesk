import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendRuntimeLogAtPath, normalizeRuntimeErrorReport } from "./runtime-log-core";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("runtime crash log", () => {
	it("persists a renderer failure as one parseable JSONL record with process context", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-runtime-log-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "nested", "gui-runtime.jsonl");

		appendRuntimeLogAtPath(
			filePath,
			{
				source: "react-render",
				message: "render exploded",
				stack: "Error: render exploded\n at Broken",
				details: { phase: "commit", retryable: true },
			},
			{ appVersion: "0.6.0", platform: "darwin", pid: 42, windowId: 7, cwd: "/project" },
		);

		const lines = (await fs.readFile(filePath, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
		expect(entry).toMatchObject({
			appVersion: "0.6.0",
			platform: "darwin",
			pid: 42,
			windowId: 7,
			cwd: "/project",
			source: "react-render",
			message: "render exploded",
		});
		expect(entry.timestamp).toEqual(expect.any(String));
	});

	it("bounds untrusted IPC fields and discards unsupported detail values", () => {
		const report = normalizeRuntimeErrorReport({
			source: "invented-source",
			message: "x".repeat(20_000),
			details: { kept: 3, nested: { secret: true }, fn: () => "ignored" },
		});

		expect(report.source).toBe("unknown");
		expect(report.message.length).toBeLessThan(8_200);
		expect(report.details).toEqual({ kept: 3 });
	});

	it("preserves packaged resource replacement reports", () => {
		const report = normalizeRuntimeErrorReport({
			source: "application-resources",
			message: "resource archive changed",
			details: { launchInode: 100, currentInode: 101 },
		});

		expect(report).toMatchObject({
			source: "application-resources",
			message: "resource archive changed",
			details: { launchInode: 100, currentInode: 101 },
		});
	});
});
