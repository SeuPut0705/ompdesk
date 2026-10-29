import { describe, expect, it } from "vitest";
import { compareToAllowList, findDuplicateRules, normalizeRegex } from "./lint-duplicate-rules.mjs";

describe("lint-duplicate-rules", () => {
	it("finds the worktree folder rule main and src/shared both spelled before 05ca85282 merged them", () => {
		// The two spellings as they stood at 05ca85282^ (excerpts; CI's checkout has no history to `git show`).
		const before = [
			{
				file: "src/main/sidebar-projects.ts",
				source: [
					"/** The folder name of a checkout OMPdesk makes under the worktree root (`gui-<name>-<hash7>`, the hash its repo's). */",
					"const OMPDESK_WORKTREE_FOLDER = /^gui-.+-([0-9a-f]{7})$/;",
				].join("\n"),
			},
			{
				file: "src/shared/project-origin.ts",
				source: [
					"export function worktreeFolderSlug(folder: string): string {",
					"\tconst name = pathBaseName(folder);",
					"\tconst match = /^gui-(.+)-[0-9a-f]{7}$/.exec(name);",
					"\treturn match?.[1] ?? name;",
					"}",
				].join("\n"),
			},
		];
		expect(findDuplicateRules(before)).toEqual([
			{
				rule: "/^gui-.+-[0-9a-f]{7}$/",
				kind: "regex",
				files: ["src/main/sidebar-projects.ts", "src/shared/project-origin.ts"],
			},
		]);
		// After the merge main imports the one export.
		const after = [
			{
				file: "src/main/sidebar-projects.ts",
				source: 'import { OMPDESK_WORKTREE_FOLDER } from "../shared/project-origin";',
			},
			{
				file: "src/shared/project-origin.ts",
				source: "export const OMPDESK_WORKTREE_FOLDER = /^gui-(.+)-([0-9a-f]{7})$/;",
			},
		];
		expect(findDuplicateRules(after)).toEqual([]);
	});

	it("compares patterns by what they match, not how their groups are spelled", () => {
		expect(normalizeRegex("/^gui-(.+)-([0-9a-f]{7})$/g")).toBe(normalizeRegex("/^gui-.+-[0-9a-f]{7}$/"));
		expect(normalizeRegex("/^(?:audio|video)\\//")).toBe("/^(audio|video)\\//");
		expect(normalizeRegex("/^(?:audio|video)\\//")).not.toBe(normalizeRegex("/^audio|video\\//"));
		expect(normalizeRegex("/(ab)+c/")).not.toBe(normalizeRegex("/ab+c/"));
		expect(normalizeRegex("/(?<=x)y/")).toBe("/(?<=x)y/");
		expect(normalizeRegex("/[()]x/i")).toBe("/[()]x/i");
		expect(normalizeRegex("/(a)\\1/")).toBe("/(a)\\1/");
	});

	it("flags a named rule or an exported constant spelled on another side, and nothing within one side", () => {
		const files = [
			{ file: "src/main/a.ts", source: "const FOLDER = /^wt-[a-z]+-\\d{4}$/;\nexport const PREFIX = 'run/';" },
			{ file: "src/main/b.ts", source: "const SAME_SIDE = /^only-main-rule$/;" },
			{ file: "src/main/c.ts", source: "export const x = /^only-main-rule$/.test(s);" },
			{
				file: "resources/gui-bridge/modes/x.ts",
				source: "if (/^wt-([a-z]+)-\\d{4}$/.test(n)) {}\nexport const PREFIX = 'run/';",
			},
			{ file: "src/renderer/y.ts", source: "if (/^inline-only-rule$/.test(n)) {}\nexport const PREFIX = 'other/';" },
			{ file: "src/shared/z.ts", source: "if (/^inline-only-rule$/.test(n)) {}" },
		];
		expect(findDuplicateRules(files).map(({ rule, files }) => [rule, files])).toEqual([
			["/^wt-[a-z]+-\\d{4}$/", ["src/main/a.ts", "resources/gui-bridge/modes/x.ts"]],
			['PREFIX = "run/"', ["src/main/a.ts", "resources/gui-bridge/modes/x.ts"]],
		]);
	});

	it("passes a listed duplicate in its listed files, and fails a new one, a copy in one more file, a stale entry and no reason", () => {
		const files = ["src/main/a.ts", "src/shared/b.ts"];
		const found = [{ rule: "/a-long-rule/", kind: "regex", files }];
		const entry = { rule: "/a-long-rule/", files, reason: "r" };
		expect(compareToAllowList(found, [entry])).toEqual([]);
		expect(compareToAllowList(found, [])).toHaveLength(1);
		const spread = [{ ...found[0], files: [...files, "resources/gui-bridge/c.ts"] }];
		expect(compareToAllowList(spread, [entry])).toEqual([
			expect.stringMatching(/^duplicate rule \/a-long-rule\/ in resources\/gui-bridge\/c\.ts \(beyond/),
		]);
		expect(compareToAllowList([], [entry])[0]).toMatch(/no longer duplicated/);
		const shrunk = [{ ...found[0], files: [...files, "src/renderer/d.ts"] }];
		expect(
			compareToAllowList(shrunk, [{ ...entry, files: [...files, "src/renderer/d.ts", "src/main/gone.ts"] }]),
		).toEqual([expect.stringMatching(/no longer in src\/main\/gone\.ts/)]);
		expect(compareToAllowList(found, [{ ...entry, reason: " " }])[0]).toMatch(/needs a reason/);
	});
});
