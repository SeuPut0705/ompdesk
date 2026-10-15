import { describe, expect, it } from "vitest";
import { parseDoctorChecks } from "./misc";

describe("parseDoctorChecks", () => {
	it("reads stock omp plugin doctor --json rows and drops rows of another shape", () => {
		const stdout = JSON.stringify([
			{ name: "plugins_directory", status: "warning", message: "Not created yet" },
			{ name: "plugin:foo", status: "ok", message: "v1.2.0 - Foo tools", fixed: false },
			{ name: "orphan:bar", status: "error" },
			{ name: "odd", status: "unknown", message: "?" },
			"noise",
		]);
		expect(parseDoctorChecks(stdout)).toEqual([
			{ name: "plugins_directory", status: "warning", message: "Not created yet" },
			{ name: "plugin:foo", status: "ok", message: "v1.2.0 - Foo tools" },
			{ name: "orphan:bar", status: "error", message: "" },
		]);
	});

	it("returns null for output that is not a JSON array", () => {
		expect(parseDoctorChecks("Plugin doctor\n✓ ok")).toBeNull();
		expect(parseDoctorChecks('{"checks":[]}')).toBeNull();
	});
});
