import { describe, expect, it } from "vitest";
import { pathMatcher } from "./fuzzy-score";

/** The paths that match `query`, best first (the order the `@` menu lists them in). */
function rank(query: string, paths: string[]): string[] {
	const match = pathMatcher(query.normalize("NFC"));
	return paths
		.flatMap(path => {
			const found = match(path.normalize("NFC"), false);
			return found ? [{ path, score: found.score }] : [];
		})
		.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1))
		.map(entry => entry.path);
}

/** The matched spans of `path` for `query`, as the text they cover. */
function highlighted(query: string, path: string): string[] | null {
	const found = pathMatcher(query)(path);
	return found?.ranges.map(([start, end]) => path.slice(start, end)) ?? null;
}

describe("pathMatcher ranking", () => {
	it("puts the file named like the query before longer names and files in folders of that name", () => {
		const paths = [
			"e2e/app-auto-update.e2e.ts",
			"src/renderer/App.tsx",
			"docs/apple/notes.md",
			"scripts/check-main-bundle.ts",
		];
		expect(rank("app", paths)[0]).toBe("src/renderer/App.tsx");
		expect(
			rank("inputarea", ["a/InputArea.next-prompt-touch.test.tsx", "b/c/InputArea.tsx", "InputAreaX.tsx"]),
		).toEqual(["b/c/InputArea.tsx", "a/InputArea.next-prompt-touch.test.tsx", "InputAreaX.tsx"]);
	});

	it("ranks an exact file name above its stem, a prefix and a loose subsequence", () => {
		expect(rank("main.ts", ["scripts/check-main-bundle.ts", "src/main/index.ts", "src/main.ts", "main.tsx"])[0]).toBe(
			"src/main.ts",
		);
		expect(rank("main", ["src/main/index.ts", "scripts/check-main-bundle.ts", "main.ts"])[0]).toBe("main.ts");
	});

	it("prefers a basename match to the same letters scattered over folders", () => {
		expect(rank("ia", ["docs/media/shot.webp", "src/InputArea.tsx"])[0]).toBe("src/InputArea.tsx");
	});

	it("scores word starts, CamelCase humps and consecutive runs above scattered letters", () => {
		expect(rank("ur", ["src/user-repo.ts", "src/blurry.ts"])[0]).toBe("src/user-repo.ts");
		expect(rank("ia", ["src/InputArea.tsx", "src/hiatus.ts"])[0]).toBe("src/InputArea.tsx");
		expect(rank("input", ["src/in-p-u-t.ts", "src/input.ts"])[0]).toBe("src/input.ts");
	});

	it("lets a path-shaped query open the path", () => {
		const paths = ["docs/src/renderer.md", "src/renderer/App.tsx", "src/main/renderer-bridge.ts"];
		expect(rank("src/ren", paths)[0]).toBe("src/renderer/App.tsx");
	});

	it("breaks equal scores by the shorter path", () => {
		const paths = ["a/b/c/util.ts", "a/util.ts", "a/b/util.ts"];
		expect(rank("util", paths)).toEqual(["a/util.ts", "a/b/util.ts", "a/b/c/util.ts"]);
	});

	it("matches nothing that is not a subsequence, and everything for an empty query", () => {
		expect(rank("zzq", ["src/a.ts"])).toEqual([]);
		expect(pathMatcher("")("src/a.ts")).toEqual({ score: 0, ranges: [] });
	});

	it("is case-insensitive", () => {
		expect(rank("APP", ["src/App.tsx"])).toEqual(["src/App.tsx"]);
		expect(rank("app", ["src/APP.tsx"])).toEqual(["src/APP.tsx"]);
	});
});

describe("pathMatcher Hangul", () => {
	it("finds a file by the initial consonants of its syllables", () => {
		expect(rank("ㅎㄱ", ["src/a.ts", "한글문서.md", "docs/하고.txt", "ㅎㄱ.md"])).toEqual([
			"ㅎㄱ.md",
			"한글문서.md",
			"docs/하고.txt",
		]);
		expect(highlighted("ㅎㄱ", "한글문서.md")).toEqual(["한글"]);
	});

	it("matches a mix of whole syllables and initials", () => {
		expect(highlighted("한ㄱㅁ", "한글문서.md")).toEqual(["한글문"]);
		expect(rank("한ㄱ", ["한국어.md", "한글.md", "한문.md"])).toEqual(["한글.md", "한국어.md"]);
	});

	it("matches a syllable still being composed to every syllable that shares its start", () => {
		// `하` is the IME's state on the way to `한`: the last typed syllable stays open.
		expect(rank("하", ["한글.md", "하루.md", "허브.md"])).toEqual(["하루.md", "한글.md"]);
		// Only the last one: an earlier `하` is final.
		expect(rank("하ㄱ", ["한글.md", "하글.md"])).toEqual(["하글.md"]);
	});

	it("reads composed and decomposed names alike once the caller normalises", () => {
		const decomposed = "한글문서.md".normalize("NFD");
		expect(rank("한글", [decomposed])).toEqual([decomposed]);
		expect(rank("ㅎㄱ", [decomposed])).toEqual([decomposed]);
	});
});

describe("pathMatcher ranges", () => {
	it("returns the file-name spans that matched, merged into runs", () => {
		expect(highlighted("input", "src/components/InputArea.tsx")).toEqual(["Input"]);
		expect(highlighted("ia", "src/InputArea.tsx")).toEqual(["I", "A"]);
		expect(pathMatcher("input")("src/InputArea.tsx")?.ranges).toEqual([[4, 9]]);
	});

	it("traces folder hits for a path-shaped query", () => {
		expect(highlighted("src/ren", "src/renderer/App.tsx")).toEqual(["src/ren"]);
	});

	it("reports no ranges when only the score was asked for", () => {
		expect(pathMatcher("app")("src/App.tsx", false)?.ranges).toEqual([]);
	});
});
