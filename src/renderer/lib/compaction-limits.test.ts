/**
 * The input rules mirror stock's config/compaction-threshold.ts
 * (parseCompactionPointInput, formatCompactionPointInput, the model key check),
 * so the editor writes exactly what stock persists and reads back.
 */
import { describe, expect, it } from "vitest";
import {
	compactionLimitEntries,
	compactionPointValue,
	formatCompactionLimit,
	modelSelectorError,
	parseCompactionLimit,
} from "./compaction-limits";

describe("parseCompactionLimit", () => {
	it("reads token counts with k/m/b suffixes and keeps percentages as strings", () => {
		expect(parseCompactionLimit("90000")).toEqual({ ok: true, value: 90_000 });
		expect(parseCompactionLimit(" 90K ")).toEqual({ ok: true, value: 90_000 });
		expect(parseCompactionLimit("1m")).toEqual({ ok: true, value: 1_000_000 });
		expect(parseCompactionLimit("80%")).toEqual({ ok: true, value: "80%" });
		expect(parseCompactionLimit("12.5%")).toEqual({ ok: true, value: "12.5%" });
		expect(parseCompactionLimit("100%")).toEqual({ ok: true, value: "100%" });
	});

	it("rejects what stock rejects", () => {
		expect(parseCompactionLimit("0%")).toEqual({ ok: false, error: "percent" });
		expect(parseCompactionLimit("101%")).toEqual({ ok: false, error: "percent" });
		for (const text of ["", "0", "1.5k", "-5", "90 k", "ninety", "1e5"]) {
			expect(parseCompactionLimit(text), text).toEqual({ ok: false, error: "invalid" });
		}
	});
});

describe("formatCompactionLimit", () => {
	it("prints the largest exact suffix, like stock's /models input prefill", () => {
		expect(formatCompactionLimit(90_000)).toBe("90k");
		expect(formatCompactionLimit(1_500_000)).toBe("1500k");
		expect(formatCompactionLimit(2_000_000)).toBe("2m");
		expect(formatCompactionLimit(123_456)).toBe("123456");
		expect(formatCompactionLimit("80%")).toBe("80%");
	});
});

describe("modelSelectorError", () => {
	it("accepts provider/model-id and *-terminated prefixes only", () => {
		expect(modelSelectorError("openai/gpt-5")).toBeNull();
		expect(modelSelectorError("openai/*")).toBeNull();
		expect(modelSelectorError("openrouter/anthropic/*")).toBeNull();
		expect(modelSelectorError("open*/x")).toBe("star");
		expect(modelSelectorError("gpt-5")).toBe("shape");
		expect(modelSelectorError("/gpt-5")).toBe("shape");
		expect(modelSelectorError("openai/")).toBe("shape");
	});
});

describe("compactionLimitEntries / compactionPointValue", () => {
	it("lists valid entries sorted, skipping null clears", () => {
		expect(compactionLimitEntries({ "z/a": 5, "a/b": "50%", "c/d": null, "e/f": "x" })).toEqual([
			["a/b", "50%"],
			["z/a", 5],
		]);
		expect(compactionLimitEntries(null)).toEqual([]);
	});

	it("shows tokens, the percentage when percent-based, or nothing when compaction is off", () => {
		expect(compactionPointValue({ tokens: 160_000, percent: 80, source: "global" })).toBe("160.0k · 80%");
		expect(compactionPointValue({ tokens: 90_000, source: "a/b" })).toBe("90.0k");
		expect(compactionPointValue({ source: "default" })).toBeNull();
	});
});
