import { describe, expect, it } from "vitest";
import { reaEnabled, reaExtensionArgs, reaNodeSupported } from "./builtin-mcp";

describe("REA Node.js engines", () => {
	it.each(["22.19.0", "v22.19.1", "22.99.0", "24.11.0", "24.20.0", "26.0.0", "27.0.0"])("accepts %s", version => {
		expect(reaNodeSupported(version)).toBe(true);
	});
	it.each(["20.19.0", "22.18.9", "23.99.0", "24.10.9", "25.99.0", "v26.0.0-rc.1", "26", "garbage"])(
		"refuses %s",
		version => {
			expect(reaNodeSupported(version)).toBe(false);
		},
	);
	it("defaults on, but does not pass the root without usable Node/npx", () => {
		expect(reaEnabled(undefined)).toBe(true);
		expect(reaEnabled(false)).toBe(false);
		expect(
			reaExtensionArgs("/resources/omp-builtin", { enabled: true, available: false, reason: "node-version" }),
		).toEqual([]);
		expect(reaExtensionArgs("/resources/omp-builtin", { enabled: false, available: true })).toEqual([]);
		expect(reaExtensionArgs("/resources/omp-builtin", { enabled: true, available: true })).toEqual([
			"-e",
			"/resources/omp-builtin",
		]);
	});
});
