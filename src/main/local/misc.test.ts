import { describe, expect, it } from "vitest";
import { handlers, parseDoctorChecks } from "./misc";

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

describe("omp updates", () => {
	it("has no local handler that runs `omp update` itself: a host updates through its OmpUpdater (host.ompUpdate.now)", () => {
		// A bare `omp update` here skipped the stats and helper release, the setup supervisor, the omp re-detection,
		// the tab restart and the serialization against the host's own scheduled update.
		expect(Object.hasOwn(handlers, "omp_update")).toBe(false);
	});
});
