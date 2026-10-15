import { describe, expect, it } from "vitest";
import { searchPattern, searchWorkspace } from "./workspace-search";

const base = { query: "a.b", matchCase: false, wholeWord: false, regex: false, glob: "" };

describe("Files content search", () => {
	it("escapes plain text, keeps a regex and wraps whole words", () => {
		expect(searchPattern(base)).toBe("a\\.b");
		expect(searchPattern({ ...base, regex: true })).toBe("a.b");
		expect(searchPattern({ ...base, wholeWord: true })).toBe("\\b(?:a\\.b)\\b");
	});
	it("hands stock grep the pattern, case and glob, and refuses bad input before calling it", async () => {
		const calls: unknown[] = [];
		const helper = async (method: string, params: unknown) => {
			calls.push({ method, params });
			return { matches: [{ path: "src/a.ts", line: 3, text: "a.b" }], files: 1, limited: false };
		};
		expect(await searchWorkspace("/repo", { ...base, matchCase: true, glob: " *.ts " }, helper)).toEqual({
			ok: true,
			matches: [{ path: "src/a.ts", line: 3, text: "a.b" }],
			files: 1,
			limited: false,
		});
		expect(calls).toEqual([
			{
				method: "search.text",
				params: { root: "/repo", pattern: "a\\.b", ignoreCase: false, glob: "*.ts", maxCount: 500 },
			},
		]);
		expect(await searchWorkspace("/repo", { ...base, query: "(", regex: true }, helper)).toMatchObject({
			ok: false,
			code: "invalid_regex",
		});
		expect(await searchWorkspace("/repo", { ...base, query: "" }, helper)).toMatchObject({ code: "invalid_path" });
		expect(await searchWorkspace(null, base, helper)).toMatchObject({ code: "no_workspace" });
		expect(calls).toHaveLength(1);
	});
});
