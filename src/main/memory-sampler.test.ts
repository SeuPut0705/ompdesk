import { describe, expect, it } from "vitest";
import { parseMacSysctl, parsePs, treeBytes, windowsReading } from "./memory-sampler";

const GiB = 1024 ** 3;

describe("parseMacSysctl", () => {
	it("reads the kernel's pressure level and free percentage of RAM", () => {
		expect(parseMacSysctl("1\n80\n17179869184\n")).toEqual({
			totalBytes: 16 * GiB,
			availableBytes: Math.round(16 * GiB * 0.8),
			pressure: "normal",
		});
		expect(parseMacSysctl("2\n14\n17179869184\n")?.pressure).toBe("warn");
		expect(parseMacSysctl("4\n3\n17179869184\n")?.pressure).toBe("critical");
	});

	it("is no reading when the values are missing", () => {
		expect(parseMacSysctl("")).toBeNull();
		expect(parseMacSysctl("1\nabc\n0")).toBeNull();
	});
});

describe("windowsReading", () => {
	it("is a warning under a tenth of RAM available and critical under a twentieth", () => {
		const total = 16 * 1024 * 1024;
		expect(windowsReading(total, total * 0.5)?.pressure).toBe("normal");
		expect(windowsReading(total, total * 0.08)?.pressure).toBe("warn");
		expect(windowsReading(total, total * 0.04)?.pressure).toBe("critical");
		expect(windowsReading(0, 0)).toBeNull();
	});
});

describe("process trees", () => {
	const rows = parsePs(
		[
			"    1     0  1000",
			"  100     1  2000",
			"  101   100  3000",
			"  102   101  4000",
			"  200     1  9000",
			"garbage",
		].join("\n"),
	);

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
