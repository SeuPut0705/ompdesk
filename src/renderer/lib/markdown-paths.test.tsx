/**
 * Bare path mentions in replies: the grammar (prose, inline code, trailing
 * line references in English and Korean) and the rendered contract — only a
 * path the tab's machine confirms becomes a link, folders included.
 */
import type { ElementContent } from "hast";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IpcFsReadResult } from "../../shared/ipc-types";
import { I18nProvider } from "./i18n";
import { MarkdownRenderer, preloadMarkdownPipeline } from "./markdown";
import { clearVerifiedPaths, pathLocation, verifyPath } from "./markdown-path-link";
import { codePathMention, linkifyProse } from "./markdown-paths";

beforeAll(() => preloadMarkdownPipeline());
afterEach(() => clearVerifiedPaths());

function mentions(parts: ElementContent[] | null): Array<{ text: string; path: unknown; line: unknown }> {
	return (parts ?? []).flatMap(part =>
		part.type === "element"
			? [
					{
						text: part.children.map(child => (child.type === "text" ? child.value : "")).join(""),
						path: part.properties.dataPath,
						line: part.properties.dataLine,
					},
				]
			: [],
	);
}

describe("linkifyProse", () => {
	it("finds paths with folders, prefixes and line references", () => {
		expect(mentions(linkifyProse("see src/app.ts:42 and ./b.md then /tmp/out/"))).toEqual([
			{ text: "src/app.ts:42", path: "src/app.ts", line: "42" },
			{ text: "./b.md", path: "./b.md", line: undefined },
			{ text: "/tmp/out/", path: "/tmp/out/", line: undefined },
		]);
		expect(mentions(linkifyProse("lib/x.ts (line 269) and docs/a.md 12번 줄"))).toEqual([
			{ text: "lib/x.ts (line 269)", path: "lib/x.ts", line: "269" },
			{ text: "docs/a.md 12번 줄", path: "docs/a.md", line: "12" },
		]);
		expect(mentions(linkifyProse("C:\\Users\\me\\a.txt#L3"))).toEqual([
			{ text: "C:\\Users\\me\\a.txt#L3", path: "C:\\Users\\me\\a.txt", line: "3" },
		]);
	});

	it("leaves prose slashes, bare names and URLs alone", () => {
		expect(linkifyProse("입력/출력 and node.js with and/or")).toBeNull();
		expect(linkifyProse("visit https://example.com/a/b.html")).toBeNull();
	});
});

describe("codePathMention", () => {
	it("accepts one path per inline code span", () => {
		expect(codePathMention("Dockerfile")).toEqual({ path: "Dockerfile" });
		expect(codePathMention("main.py:10")).toEqual({ path: "main.py", line: 10 });
		expect(codePathMention("output/제안서 최종.pptx")).toEqual({ path: "output/제안서 최종.pptx" });
		expect(codePathMention("output/")).toEqual({ path: "output/" });
	});

	it("refuses commands, packages and plain words", () => {
		expect(codePathMention("python scripts/run.py")).toBeNull();
		expect(codePathMention("owner/repo")).toBeNull();
		expect(codePathMention("useState")).toBeNull();
		expect(codePathMention("output")).toBeNull();
	});
});

describe("pathLocation", () => {
	it("reads a line from an explicit link", () => {
		expect(pathLocation("src/a.ts:42", "src/a.ts:42")).toEqual({ path: "src/a.ts", line: 42 });
		expect(pathLocation("src/a.ts", "src/a.ts#L7")).toEqual({ path: "src/a.ts", line: 7 });
		expect(pathLocation("C:\\a.ts", "C:\\a.ts")).toEqual({ path: "C:\\a.ts" });
	});
});

describe("rendered path mentions", () => {
	it("links only paths the tab's machine confirms", async () => {
		const read = vi.fn(async (path: string): Promise<IpcFsReadResult> => {
			const base = { content: "", truncated: false, binary: false, size: 1 };
			if (path === "src/app.ts") return { ok: true, ...base };
			if (path === "out/") return { ok: false, ...base, error: "Not a file", code: "not_a_file" };
			return { ok: false, ...base, error: "ENOENT" };
		});
		const globals = globalThis as Record<string, unknown>;
		const previous = globals.window;
		globals.window = { omp: { fs: { read } } };
		try {
			for (const path of ["src/app.ts", "out/", "src/gone.ts"]) await verifyPath(path, null);
			const html = renderToStaticMarkup(
				<I18nProvider>
					<MarkdownRenderer content={"Edit src/app.ts:3, results in `out/`, not src/gone.ts."} />
				</I18nProvider>,
			);
			expect(html).toContain('data-path-link="file" href="src/app.ts"');
			expect(html).toContain('title="src/app.ts:3"');
			expect(html).toContain('data-path-link="dir" href="out/"');
			expect(html).not.toContain('href="src/gone.ts"');
			expect(html).toContain("src/gone.ts");
			expect(read).toHaveBeenCalledWith("src/app.ts", 1, undefined);
		} finally {
			globals.window = previous;
		}
	});
});
