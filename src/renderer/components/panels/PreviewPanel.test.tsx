import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	clampPreviewZoom,
	EMPTY_PREVIEW,
	isLoopbackUrl,
	PREVIEW_PROBLEM_LIMIT,
	previewAddress,
	previewProblemCount,
	previewUrl,
	reducePreviewState,
} from "../../../shared/preview";
import { I18nProvider } from "../../lib/i18n";
import { detectLocalPreviewUrls, latestBashPreviewUrl } from "../../lib/preview-browser";
import type { ToolEntry } from "../../stores/tools";
import { BashRenderer } from "../tools/BashRenderer";
import { PreviewPanel } from "./PreviewPanel";

const entry = (text: string, time: number, toolName = "bash"): ToolEntry => ({
	toolName,
	args: {},
	status: "done",
	streamingArgs: "",
	result: { content: [{ type: "text", text }] },
	isError: false,
	startTime: time,
	endTime: time,
});
describe("browser preview", () => {
	it("renders a labeled URL bar, disabled history controls and a real empty-state hint", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<PreviewPanel />
			</I18nProvider>,
		);
		expect(html).toContain('aria-label="Preview URL"');
		expect(html).toContain('aria-label="Back"');
		expect(html).toContain("Start a local development server");
		expect(html).toContain("Enter URL");
		expect(html).toContain('inputMode="url"');
		expect(html).toContain("data-preview-surface");
		expect(html).not.toContain("<iframe");
		expect(html).not.toContain("<webview");
	});
	it("links bash loopback URLs while preserving the stock ANSI renderer", () => {
		for (const text of ["Server: http://localhost:5173/", "\x1b[32mServer: http://localhost:5173/\x1b[0m"]) {
			const html = renderToStaticMarkup(
				<I18nProvider>
					<BashRenderer args={{ command: "npm run dev" }} result={{ content: [{ type: "text", text }] }} />
				</I18nProvider>,
			);
			expect(html).toContain('href="http://localhost:5173/"');
			expect(html).toContain("Server:");
			expect(html).not.toContain("\x1b");
		}
	});
	it("detects only loopback HTTP URLs and removes console punctuation", () => {
		expect(
			detectLocalPreviewUrls(
				"Local: http://localhost:5173/\n(http://127.0.0.1:3000/app). https://example.org javascript:alert(1)\n\x1b[32mhttp://localhost:8080\x1b[0m",
			),
		).toEqual(["http://localhost:5173/", "http://127.0.0.1:3000/app", "http://localhost:8080/"]);
		expect(detectLocalPreviewUrls("http://localhost.evil.test:80 http://user:secret@localhost:80")).toEqual([]);
	});
	it("offers a server that printed a wildcard address on localhost", () => {
		expect(
			detectLocalPreviewUrls(
				"Serving HTTP on :: port 4790 (http://[::]:4790/) ...\nListening on http://0.0.0.0:5173/app and again http://0.0.0.0:5173/app",
			),
		).toEqual(["http://localhost:4790/", "http://localhost:5173/app"]);
		expect(detectLocalPreviewUrls("http://0.0.0.0.evil.test:80 http://[::2]:80")).toEqual([]);
	});
	it("selects the most recent bash result, including live stock updates", () => {
		const finishedTools = new Map([
			["old", entry("http://localhost:3000", 1)],
			["new", entry("http://127.0.0.1:4000", 3)],
			["read", entry("http://localhost:9999", 5, "read")],
		]);
		expect(latestBashPreviewUrl({ finishedTools, liveTools: new Map(), partialResults: new Map() })).toBe(
			"http://127.0.0.1:4000/",
		);
		expect(
			latestBashPreviewUrl({
				finishedTools,
				liveTools: new Map([["live", entry("", 6)]]),
				partialResults: new Map([["live", { content: [{ type: "text", text: "http://localhost:5000" }] }]]),
			}),
		).toBe("http://localhost:5000/");
	});
	it("reduces navigation loading, history and failure without losing URL", () => {
		const loading = reducePreviewState(EMPTY_PREVIEW, { url: "http://localhost/", loading: true });
		const loaded = reducePreviewState(loading, { title: "Test page", loading: false, canGoBack: true });
		expect(loaded).toMatchObject({ title: "Test page", loading: false, canGoBack: true, url: "http://localhost/" });
		expect(reducePreviewState(loaded, { error: "Connection refused", loading: false }).error).toBe(
			"Connection refused",
		);
	});
	it("rejects privileged schemes and credentials", () => {
		for (const value of [
			"file:///tmp/a",
			"javascript:alert(1)",
			"data:text/html,test",
			"http://user:secret@localhost",
		])
			expect(previewUrl(value)).toBeNull();
		expect(previewUrl("https://example.com")).toBe("https://example.com/");
		expect(isLoopbackUrl("http://[::1]:3000")).toBe(true);
	});
	it("reads the address bar as a URL, a host or a web search", () => {
		expect(previewAddress("localhost:3000")).toBe("http://localhost:3000/");
		expect(previewAddress("127.0.0.1:8080/app?x=1")).toBe("http://127.0.0.1:8080/app?x=1");
		expect(previewAddress("[::1]:5173")).toBe("http://[::1]:5173/");
		expect(previewAddress("example.com/docs")).toBe("https://example.com/docs");
		expect(previewAddress("  https://example.org  ")).toBe("https://example.org/");
		expect(previewAddress("react hooks")).toBe("https://www.google.com/search?q=react%20hooks");
		expect(previewAddress("javascript:alert(1)")).toBe("https://www.google.com/search?q=javascript%3Aalert(1)");
		expect(previewAddress("a@b.com")).toBe("https://www.google.com/search?q=a%40b.com");
		expect(previewAddress("file:///etc/passwd")).toBeNull();
		expect(previewAddress("http://user:pw@localhost")).toBeNull();
		expect(previewAddress("   ")).toBeNull();
	});
	it("keeps zoom on 10 % steps inside 50–200 %", () => {
		expect(clampPreviewZoom(1.1 + 0.1)).toBe(1.2);
		expect(clampPreviewZoom(0.3)).toBe(0.5);
		expect(clampPreviewZoom(5)).toBe(2);
		expect(clampPreviewZoom(Number.NaN)).toBe(1);
	});
	it("counts console problems up to the cap and says '+' once older ones were dropped", () => {
		expect(previewProblemCount(2)).toBe("2");
		expect(previewProblemCount(PREVIEW_PROBLEM_LIMIT - 1)).toBe(String(PREVIEW_PROBLEM_LIMIT - 1));
		expect(previewProblemCount(PREVIEW_PROBLEM_LIMIT)).toBe(`${PREVIEW_PROBLEM_LIMIT}+`);
	});
});
