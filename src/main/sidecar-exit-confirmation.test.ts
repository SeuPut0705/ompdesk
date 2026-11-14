import { expect, it, vi } from "vitest";
import { type CoreAnswer, CoreError, core } from "./core/process";
import { SidecarManager } from "./sidecar";

it("preserves a real sidecar exit-confirmation failure for its close consumer", async () => {
	const failure = new CoreError("fixture_exit_unconfirmed", "the execution exit could not be confirmed");
	const lane = Promise.withResolvers<CoreAnswer<never>>();
	const call = vi
		.spyOn(core(), "call")
		.mockImplementation(method => (method === "sidecar.whenExited" ? Promise.reject(failure) : lane.promise));
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	const sidecar = new SidecarManager({
		cwd: "/synthetic/exit-confirmation",
		omp: async () => ({ ok: false, error: "fixture omp resolver must not run" }),
	});
	try {
		sidecar.start();
		await expect(sidecar.whenExited()).rejects.toBe(failure);
	} finally {
		sidecar.dispose();
		lane.reject(new Error("fixture lane ended"));
		await Promise.allSettled([lane.promise]);
		call.mockRestore();
		warning.mockRestore();
	}
});
