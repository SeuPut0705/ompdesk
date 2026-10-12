import { describe, expect, it } from "vitest";
import { toolDiffStats } from "./diff-stats";

describe("toolDiffStats", () => {
	it("counts a written file's final newline as the end of its last line", () => {
		expect(toolDiffStats("write", { path: "notes.txt", content: "alpha\n" }, { content: [] }, false)).toEqual({
			added: 1,
			removed: 0,
		});
		expect(toolDiffStats("write", { path: "notes.txt", content: "one\ntwo" }, { content: [] }, false)).toEqual({
			added: 2,
			removed: 0,
		});
		expect(toolDiffStats("write", { path: "empty.txt", content: "" }, { content: [] }, false)).toEqual({
			added: 0,
			removed: 0,
		});
	});
});
