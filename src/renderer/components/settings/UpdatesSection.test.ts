import { describe, expect, it } from "vitest";
import type { RpcOmpUpdateResult } from "../../../shared/rpc-types";
import { updateOverviewState } from "./UpdatesSection";

const CURRENT_CORE: RpcOmpUpdateResult = {
	currentVersion: "17.2.10",
	latestVersion: "17.2.10",
	updateAvailable: false,
	checkedAt: "2026-08-10T00:00:00.000Z",
	distribution: "system",
	installStrategy: "omp-update",
};

describe("updates overview state", () => {
	it("does not claim the system is healthy before both checks finish", () => {
		expect(updateOverviewState({ state: "idle" }, undefined, undefined, false)).toBe("checking");
		expect(updateOverviewState({ state: "checking" }, CURRENT_CORE, undefined, true)).toBe("checking");
		expect(updateOverviewState({ state: "error", message: "stale" }, CURRENT_CORE, "stale", true)).toBe("checking");
	});

	it("surfaces updater and core failures instead of rendering up to date", () => {
		expect(updateOverviewState({ state: "error", message: "offline" }, CURRENT_CORE, undefined, false)).toBe("error");
		expect(updateOverviewState({ state: "not-available", version: "0.7.1" }, undefined, "offline", false)).toBe(
			"error",
		);
	});

	it("reports attention when either deliverable has an update", () => {
		expect(
			updateOverviewState({ state: "available", version: "0.7.2", mode: "manual" }, CURRENT_CORE, undefined, false),
		).toBe("attention");
		expect(
			updateOverviewState(
				{ state: "not-available", version: "0.7.1" },
				{ ...CURRENT_CORE, latestVersion: "17.2.12", updateAvailable: true },
				undefined,
				false,
			),
		).toBe("attention");
	});

	it("reports healthy only after both checks explicitly succeed", () => {
		expect(updateOverviewState({ state: "not-available", version: "0.7.1" }, CURRENT_CORE, undefined, false)).toBe(
			"healthy",
		);
	});
});
