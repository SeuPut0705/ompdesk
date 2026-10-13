import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EMPTY_PREVIEW, isLoopbackUrl, previewUrl, reducePreviewState } from "../../../shared/preview";
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
});
