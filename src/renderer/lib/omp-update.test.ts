import { describe, expect, it } from "vitest";
import { translate } from "./i18n";
import { ompUpdatedToast } from "./omp-update";

describe("ompUpdatedToast", () => {
	it("is one quiet info toast that expires on its own", () => {
		const input = ompUpdatedToast({ version: "18.9.0" }, translate);
		expect(input).toEqual({ variant: "info", message: "omp updated to 18.9.0" });
		expect(input.durationMs).toBeUndefined();
	});
});
