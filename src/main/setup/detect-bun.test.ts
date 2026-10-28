import { describe, expect, it } from "vitest";
import type { SetupPresence } from "../../shared/setup";
import { bunForOmp } from "./detect";

describe("machine setup's Bun as omp needs it", () => {
	const bun = (version: string | null): SetupPresence => ({ kind: "present", version, path: "/u/.bun/bin/bun" });

	it("calls a Bun below the omp package's engines.bun outdated, so setup upgrades it before omp", () => {
		expect(bunForOmp(bun("1.4.2"), "1.4.4")).toEqual({
			kind: "outdated",
			version: "1.4.2",
			minimum: "1.4.4",
			path: "/u/.bun/bin/bun",
		});
	});

	it("leaves a Bun that meets it, an unknown version, a missing Bun and an omp naming no minimum as found", () => {
		expect(bunForOmp(bun("1.4.4"), "1.4.4")).toEqual(bun("1.4.4"));
		expect(bunForOmp(bun("1.5.0"), "1.4.4")).toEqual(bun("1.5.0"));
		expect(bunForOmp(bun(null), "1.4.4")).toEqual(bun(null));
		expect(bunForOmp({ kind: "missing" }, "1.4.4")).toEqual({ kind: "missing" });
		expect(bunForOmp(bun("1.0.0"), null)).toEqual(bun("1.0.0"));
	});
});
