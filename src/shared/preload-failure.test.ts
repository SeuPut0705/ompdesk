import { describe, expect, it } from "vitest";
import { describePreloadFailure } from "./preload-failure";

describe("describePreloadFailure", () => {
	it("keeps an Error's message and stack", () => {
		const error = new TypeError("boom");
		const failure = describePreloadFailure(error);
		expect(failure.message).toBe("boom");
		expect(failure.stack).toContain("TypeError: boom");
	});

	it("builds a stack for an Error without one", () => {
		const error = new RangeError("no stack");
		error.stack = undefined;
		expect(describePreloadFailure(error)).toEqual({ message: "no stack", stack: "RangeError: no stack" });
	});

	it("turns a thrown string, object or null into text", () => {
		expect(describePreloadFailure("plain")).toEqual({ message: "plain", stack: "plain" });
		expect(describePreloadFailure(null)).toEqual({ message: "null", stack: "null" });
		expect(describePreloadFailure({ code: 1 }).message).toBe("[object Object]");
	});

	it("does not throw for a value whose text cannot be made", () => {
		const hostile = {
			toString: () => {
				throw new Error("no");
			},
		};
		expect(describePreloadFailure(hostile)).toEqual({
			message: "unprintable value thrown",
			stack: "unprintable value thrown",
		});
	});
});
