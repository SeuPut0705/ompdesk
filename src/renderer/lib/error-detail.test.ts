import { describe, expect, it } from "vitest";
import { errorDetail } from "./error-detail";

describe("errorDetail", () => {
	it("strips the Electron IPC wrapper and the error-class prefix", () => {
		expect(
			errorDetail(new Error("Error invoking remote method 'sessions:rename': Error: EACCES: permission denied")),
		).toBe("EACCES: permission denied");
		expect(errorDetail("TypeError: x is not a function")).toBe("x is not a function");
	});

	it("keeps plain messages and maps nullish causes to an empty detail", () => {
		expect(errorDetail(new Error("git status failed"))).toBe("git status failed");
		expect(errorDetail(undefined)).toBe("");
		expect(errorDetail(null)).toBe("");
	});
});
