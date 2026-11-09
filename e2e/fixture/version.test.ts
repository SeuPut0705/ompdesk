import { expect, it } from "vitest";
import { MIN_OMP_VERSION } from "../../src/main/omp-runtime";
import { isNewer } from "../../src/shared/version";
import { FIXTURE_MIN_OMP_VERSION, FIXTURE_NEWER_OMP_VERSION } from "./version";

it("the fake omp reports the oldest omp the app accepts, and its update scenarios a newer one", () => {
	expect(FIXTURE_MIN_OMP_VERSION).toBe(MIN_OMP_VERSION);
	expect(isNewer(FIXTURE_NEWER_OMP_VERSION, MIN_OMP_VERSION)).toBe(true);
});
