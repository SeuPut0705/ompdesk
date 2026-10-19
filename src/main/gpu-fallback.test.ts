import { describe, expect, it } from "vitest";
import { isGpuProcessCrash, markerForcesSoftware } from "./gpu-fallback";

describe("isGpuProcessCrash", () => {
	it("triggers the fallback only for GPU process failures", () => {
		expect(isGpuProcessCrash({ type: "GPU", reason: "crashed" })).toBe(true);
		expect(isGpuProcessCrash({ type: "GPU", reason: "oom" })).toBe(true);
		expect(isGpuProcessCrash({ type: "GPU", reason: "launch-failed" })).toBe(true);

		// A normal GPU-process shutdown is lifecycle, not failure.
		expect(isGpuProcessCrash({ type: "GPU", reason: "clean-exit" })).toBe(false);

		// Windows logoff, shutdown or an installer ends the whole tree with DBG_TERMINATE_PROCESS
		// (0x40010004): the GPU process is "killed" beside the network service, which is no GPU failure.
		expect(isGpuProcessCrash({ type: "GPU", reason: "killed" })).toBe(false);

		// Renderer/utility process exits take other recovery paths.
		expect(isGpuProcessCrash({ type: "Tab", reason: "crashed" })).toBe(false);
		expect(isGpuProcessCrash({ type: "Utility", reason: "crashed" })).toBe(false);
	});
});

describe("markerForcesSoftware", () => {
	it("keeps software rendering only for a marker left by a real GPU failure", () => {
		expect(markerForcesSoftware(JSON.stringify({ reason: "crashed", exitCode: -1 }))).toBe(true);
		expect(markerForcesSoftware(JSON.stringify({ reason: "killed", exitCode: 1073807364 }))).toBe(false);
		expect(markerForcesSoftware("not json")).toBe(true);
	});
});
