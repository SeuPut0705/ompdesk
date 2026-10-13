import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { parseDiff } from "../../lib/diff";
import { I18nProvider } from "../../lib/i18n";
import { liveDiffPreview } from "./live-diff";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
// React DOM must initialize after linkedom globals; static imports initialize it too early.
const { createRoot } = await import("react-dom/client");
const { BashRenderer } = await import("./BashRenderer");
const { EditRenderer } = await import("./EditRenderer");
const { GrepRenderer } = await import("./GrepRenderer");
const { GlobRenderer } = await import("./GlobRenderer");
const { BrowserRenderer } = await import("./BrowserRenderer");
const { ComputerRenderer } = await import("./ComputerRenderer");
const { EvalRenderer } = await import("./EvalRenderer");
const { ReadRenderer } = await import("./ReadRenderer");
const { WriteRenderer } = await import("./WriteRenderer");
const { WebSearchRenderer } = await import("./WebSearchRenderer");
const { FindRenderer } = await import("./FindRenderer");
let root: Root | undefined;
let container: HTMLElement;
async function mount(element: ReactElement) {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(<I18nProvider>{element}</I18nProvider>));
}
afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});
const result = (text: string, details: Record<string, unknown> = {}) => ({
	content: [{ type: "text", text }],
	details,
});

describe("live tool screens", () => {
	it("shows one prompt and exit state without the PTY echo or trailer", async () => {
		await mount(
			<BashRenderer
				livePreview
				args={{ command: "false" }}
				isError
				result={result("false\nfailed\nCommand exited with code 1", { exitCode: 1, wallTimeMs: 420 })}
			/>,
		);
		expect(container.textContent?.match(/false/g)).toHaveLength(1);
		expect(container.textContent?.match(/exit 1/g)).toHaveLength(1);
		expect(container.textContent).not.toContain("Exit: 1");
		expect(container.querySelector(".omp-bash-elapsed")?.textContent).toBe("420ms");
		expect(container.querySelector(".omp-bash-line")?.textContent).toContain("failed");
	});
	it("reserves a live terminal output viewport before the first line", async () => {
		await mount(<BashRenderer livePreview isPartial args={{ command: "long-job" }} result={undefined} />);
		expect(container.querySelector(".omp-bash-live > div:nth-child(2)")).not.toBeNull();
	});
	it("renders the newest live terminal line last, keeping blank rows", async () => {
		await mount(
			<div className="omp-work-motion" data-running="true">
				<BashRenderer
					livePreview
					isPartial
					args={{ command: "long-job" }}
					result={undefined}
					partialResult={result("first\n\nnewest")}
				/>
			</div>,
		);
		const newest = container.querySelector('.omp-work-motion[data-running="true"] .omp-bash-line:last-child');
		expect(newest?.textContent).toBe("newest");
		expect(container.querySelectorAll(".omp-bash-line")).toHaveLength(3);
	});
	it("keeps transcript terminal echoes unchanged", async () => {
		await mount(<BashRenderer args={{ command: "echo hi" }} result={result("echo hi\nhi")} />);
		expect(container.textContent?.match(/echo hi/g)).toHaveLength(2);
		expect(container.querySelector(".omp-bash-live")).toBeNull();
	});
	it("bounds the editor to the latest changed region with actual file numbers", () => {
		const diff = `@@ -1,120 +1,120 @@\n${Array.from({ length: 120 }, (_, i) => `+line ${i + 1}`).join("\n")}`;
		const preview = liveDiffPreview(diff);
		expect(parseDiff(preview)).toHaveLength(80);
		expect(preview).toContain("+41|line 41");
		expect(preview.endsWith("+120|line 120")).toBe(true);
	});
	it("preserves both gutters and hunk gaps in a small live diff", () => {
		const diff = "@@ -1,2 +1,2 @@\n first\n-old\n+new\n@@ -30 +30 @@\n last";
		expect(liveDiffPreview(diff)).toBe(diff);
	});
	it("keeps the latest edit and omits distant trailing context", () => {
		const diff = `@@ -30,100 +30,100 @@\n-old\n+new\n${Array.from({ length: 99 }, (_, i) => ` context ${i}`).join("\n")}`;
		const preview = liveDiffPreview(diff);
		expect(preview).toContain("+30|new");
		expect(preview).not.toContain("context 98");
	});
	it("lets the diff stand alone under the card heading for a live single-file edit", async () => {
		await mount(
			<EditRenderer
				livePreview
				args={{ path: "src/file.ts" }}
				result={result("", { diff: "@@ -3 +3 @@\n-old\n+new" })}
			/>,
		);
		expect(container.querySelector(".omp-tool-edit-heading")).toBeNull();
		expect(container.textContent).toContain("new");
	});
	it("keeps the operation row for live deletes and moves, which have no diff to show", async () => {
		await mount(
			<EditRenderer
				livePreview
				args={{ path: "src/old.ts" }}
				result={result("", { path: "src/old.ts", op: "delete" })}
			/>,
		);
		expect(container.querySelector(".omp-tool-edit-heading")?.textContent).toBe("Deleteold.tssrc");
		await act(async () => root?.unmount());
		container.remove();
		await mount(
			<EditRenderer
				livePreview
				args={{ path: "src/old.ts", rename: "lib/new.ts" }}
				result={result("", { path: "src/old.ts", move: "lib/new.ts" })}
			/>,
		);
		const row = container.querySelector(".omp-tool-edit-heading")?.textContent ?? "";
		expect(row).toContain("old.ts");
		expect(row).toContain("→new.tslib");
	});
	it("names each file of a live multi-file edit without repeating the operation", async () => {
		await mount(
			<EditRenderer
				livePreview
				args={{ edits: [{ path: "a.ts" }, { path: "b.ts" }] }}
				result={result("", {
					perFileResults: [
						{ path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+A" },
						{ path: "b.ts", op: "delete", diff: "" },
					],
				})}
			/>,
		);
		const rows = [...container.querySelectorAll(".omp-tool-edit-heading")].map(row => row.textContent);
		expect(rows[0]).not.toContain("Edit");
		expect(rows[0]).toContain("a.ts");
		expect(rows[1]).toBe("Deleteb.ts");
	});
	it("shows grep paths and matched lines without repeating the search header", async () => {
		await mount(<GrepRenderer livePreview args={{ pattern: "needle" }} result={result("file.ts:7:needle found")} />);
		expect(container.textContent).toContain("file.ts");
		expect(container.textContent).toContain("7");
		expect(container.textContent).toContain("needle found");
		expect(container.textContent).not.toContain("/needle/");
	});
	it("shows glob paths without repeating the pattern", async () => {
		await mount(
			<GlobRenderer livePreview args={{ path: "**/*.ts" }} result={result("", { files: ["src/file.ts"] })} />,
		);
		expect(container.textContent).toContain("src/file.ts");
		expect(container.textContent).not.toContain("**/*.ts");
	});
	it("uses a concise browser URL caption", async () => {
		await mount(
			<BrowserRenderer
				livePreview
				args={{ action: "run", url: "https://example.com" }}
				result={result("Page loaded")}
			/>,
		);
		expect(container.querySelector(".omp-tool-caption")?.textContent).toBe("https://example.com");
	});
	it("keeps computer action and coordinates in its caption", async () => {
		await mount(
			<ComputerRenderer livePreview args={{ action: "click", coordinate: [10, 20] }} result={result("Clicked")} />,
		);
		expect(container.querySelector(".omp-tool-caption")?.textContent).toContain("click(10, 20)");
	});
	it("keeps eval code and output but removes redundant title and language chrome", async () => {
		await mount(<EvalRenderer livePreview args={{ code: "1 + 1", title: "Calculation" }} result={result("2")} />);
		expect(container.textContent).toContain("1 + 1");
		expect(container.textContent).not.toContain("Calculation");
		expect(container.textContent).not.toContain("JavaScript");
	});
	it("keeps ranged read line numbers", async () => {
		await mount(
			<ReadRenderer
				livePreview
				args={{ path: "file.txt:40-41" }}
				result={result("", { displayContent: { text: "first\nsecond", startLine: 40 } })}
			/>,
		);
		expect(container.textContent).toContain("40");
		expect(container.textContent).toContain("41");
		expect(container.textContent).toContain("second");
	});
	it("keeps write content in a numbered editor without a second path", async () => {
		await mount(
			<WriteRenderer livePreview args={{ path: "file.txt", content: "first\nsecond" }} result={undefined} />,
		);
		expect(container.querySelector(".omp-tool-write")).not.toBeNull();
		expect(container.textContent).toContain("second");
		expect(container.textContent).not.toContain("file.txt");
	});
	it("shows web sources as a result list without query or provider duplication", async () => {
		await mount(
			<WebSearchRenderer
				livePreview
				args={{ query: "keyboard navigation" }}
				result={result("", {
					response: {
						answer: "Summary",
						provider: "Provider",
						sources: [{ title: "Accessibility", url: "https://example.com", snippet: "Reachable controls" }],
					},
				})}
			/>,
		);
		expect(container.textContent).toContain("Accessibility");
		expect(container.textContent).toContain("Reachable controls");
		expect(container.textContent).not.toContain("keyboard navigation");
		expect(container.textContent).not.toContain("Provider");
	});
	it("keeps semantic search paths and passages without query metadata", async () => {
		await mount(
			<FindRenderer
				livePreview
				args={{ query: "auth flow" }}
				result={result("", {
					query: "auth flow",
					cwd: "/repo",
					hits: [
						{
							rel: "src/auth.ts",
							contentScore: 0.9,
							linesSeen: 100,
							truncated: false,
							ranges: [{ start: 10, end: 12, p: 0.8, snippet: "login()" }],
						},
					],
				})}
			/>,
		);
		expect(container.textContent).toContain("src/auth.ts");
		expect(container.textContent).toContain(":10–12");
		expect(container.textContent).toContain("login()");
		expect(container.textContent).not.toContain("auth flow");
	});
});
