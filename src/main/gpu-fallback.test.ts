import { describe, expect, it } from "vitest";
import { isGpuProcessCrash } from "./gpu-fallback";

describe("isGpuProcessCrash", () => {
	it("triggers the fallback only for GPU process failures", () => {
		expect(isGpuProcessCrash({ type: "GPU", reason: "crashed" })).toBe(true);
		expect(isGpuProcessCrash({ type: "GPU", reason: "oom" })).toBe(true);
		expect(isGpuProcessCrash({ type: "GPU", reason: "launch-failed" })).toBe(true);

		// A normal GPU-process shutdown is lifecycle, not failure.
		expect(isGpuProcessCrash({ type: "GPU", reason: "clean-exit" })).toBe(false);

		// Renderer/utility process exits take other recovery paths.
		expect(isGpuProcessCrash({ type: "Tab", reason: "crashed" })).toBe(false);
		expect(isGpuProcessCrash({ type: "Utility", reason: "crashed" })).toBe(false);
	});
});
