import { describe, expect, it } from "vitest";
import { compactionPointValue } from "./compaction-limits";

describe("compaction point presentation", () => {
	it("shows tokens, percentages, or nothing when compaction is off", () => {
		expect(compactionPointValue({ tokens: 160_000, percent: 80, source: "global" })).toBe("160.0k · 80%");
		expect(compactionPointValue({ tokens: 90_000, source: "a/b" })).toBe("90.0k");
		expect(compactionPointValue({ source: "default" })).toBeNull();
	});
});
