/** ⌘P quick open ranking: file-name hits lead path hits, prefix beats substring beats fuzzy. */
import { describe, expect, it } from "vitest";
import { rankQuickOpen } from "./quick-open";

const paths = [
	"docs/app-guide.md",
	"src/app.ts",
	"src/main/application.ts",
	"src/renderer/App.tsx",
	"src/renderer/components/layout/AppShell.tsx",
	"src/shared/apex.ts",
	"test/fixtures/a/p/p.txt",
];

describe("rankQuickOpen", () => {
	it("keeps the listing order for an empty query, capped", () => {
		expect(rankQuickOpen(paths, "  ", 3)).toEqual(paths.slice(0, 3));
	});

	it("ranks file-name prefix, then name substring, then name fuzzy, then path-only matches", () => {
		// Prefix hits: the shortest file name first, then the shallower path.
		expect(rankQuickOpen(paths, "app", 10)).toEqual([
			"src/app.ts",
			"src/renderer/App.tsx",
			"docs/app-guide.md",
			"src/renderer/components/layout/AppShell.tsx",
			"src/main/application.ts",
			"test/fixtures/a/p/p.txt",
		]);
		expect(rankQuickOpen(paths, "shell", 10)).toEqual(["src/renderer/components/layout/AppShell.tsx"]);
		// Name fuzzy hits tie on score: the shorter name, then the shallower path; path-only last.
		expect(rankQuickOpen(paths, "apx", 10)).toEqual([
			"src/shared/apex.ts",
			"src/renderer/App.tsx",
			"src/renderer/components/layout/AppShell.tsx",
			"test/fixtures/a/p/p.txt",
		]);
	});

	it("matches across directories when the query names a path", () => {
		expect(rankQuickOpen(paths, "layout/shell", 10)).toEqual(["src/renderer/components/layout/AppShell.tsx"]);
		expect(rankQuickOpen(paths, "zzz", 10)).toEqual([]);
	});
});
