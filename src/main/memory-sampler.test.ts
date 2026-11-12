import { spawn } from "node:child_process";
import { once } from "node:events";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { listProcesses, type ProcessRow, readMemory, treeBytes } from "./memory-sampler";
import { DIES_WITH_TEST } from "./test-fake-omp";

// parseMacSysctl, windowsReading and parsePs moved to the core process with their cases
// (native/ompdesk/crates/core/src/memory/mod.rs); the cases below read this computer through it.

describe("the core's reading of this computer", () => {
	it("reports the RAM the OS reports, and no more available than there is", async () => {
		const reading = await readMemory();
		// Windows and Linux count whole KB; macOS' hw.memsize is a multiple of one.
		expect(reading?.totalBytes).toBe(Math.floor(os.totalmem() / 1024) * 1024);
		expect(reading?.availableBytes).toBeGreaterThanOrEqual(0);
		expect(["normal", "warn", "critical"]).toContain(reading?.pressure);
		// Windows: the available physical memory node reads too, a moment apart.
		if (process.platform === "win32")
			expect(Math.abs((reading?.availableBytes ?? 0) - os.freemem())).toBeLessThan(os.totalmem() / 4);
	});

	it("lists this process under its parent, and a child it starts under it", async () => {
		// The child says when node is up in it: a process a moment old holds almost no memory yet.
		const child = spawn(
			process.execPath,
			["-e", `${DIES_WITH_TEST} process.stdout.write("up"); setInterval(() => {}, 1e9)`],
			{ stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
		);
		try {
			await once(child.stdout, "data");
			const rows = (await listProcesses()) ?? [];
			const own = rows.find(row => row.pid === process.pid);
			const started = rows.find(row => row.pid === child.pid);
			expect(own?.ppid).toBe(process.ppid);
			expect(started?.ppid).toBe(process.pid);
			// Resident bytes of a process that holds vitest: tens of MB, within a factor of what node reports for itself.
			const rss = process.memoryUsage().rss;
			expect(own?.bytes).toBeGreaterThan(rss / 4);
			expect(own?.bytes).toBeLessThan(rss * 4);
			expect(started?.bytes).toBeGreaterThan(1024 ** 2);
			expect(treeBytes(rows, process.pid)).toBeGreaterThanOrEqual((own?.bytes ?? 0) + (started?.bytes ?? 0));
			// Windows names each image (idle release tells conhost.exe from work by it); ps names none.
			expect(own?.name?.toLowerCase()).toBe(
				process.platform === "win32" ? path.basename(process.execPath).toLowerCase() : undefined,
			);
		} finally {
			child.kill();
		}
	});
});

describe("process trees", () => {
	const KB = 1024;
	const rows: ProcessRow[] = [
		{ pid: 1, ppid: 0, bytes: 1000 * KB },
		{ pid: 100, ppid: 1, bytes: 2000 * KB },
		{ pid: 101, ppid: 100, bytes: 3000 * KB },
		{ pid: 102, ppid: 101, bytes: 4000 * KB },
		{ pid: 200, ppid: 1, bytes: 9000 * KB },
	];

	it("sums a session's omp and everything below it", () => {
		expect(treeBytes(rows, 100)).toBe((2000 + 3000 + 4000) * 1024);
		expect(treeBytes(rows, 200)).toBe(9000 * 1024);
	});

	it("is nothing for a process that is gone, and survives a cycle in the listing", () => {
		expect(treeBytes(rows, 999)).toBe(0);
		expect(
			treeBytes(
				[
					{ pid: 5, ppid: 6, bytes: 1 },
					{ pid: 6, ppid: 5, bytes: 2 },
				],
				5,
			),
		).toBe(3);
	});
});
