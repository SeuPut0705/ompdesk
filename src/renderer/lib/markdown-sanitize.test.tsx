/**
 * Contract tests for the markdown sanitize schema's class lockdown: model
 * output is untrusted, and compiled Tailwind utilities are present in the
 * bundle — a surviving `class="fixed inset-0 z-50"` on raw HTML would let
 * assistant text overlay and intercept the whole app. Only the renderer-owned
 * `language-*` token on code may survive (fence detection + mermaid routing).
 */
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n";
import { MarkdownRenderer } from "./markdown";

function render(content: string): string {
	return renderToStaticMarkup(
		<I18nProvider>
			<MarkdownRenderer content={content} />
		</I18nProvider>,
	);
}

describe("markdown sanitize class lockdown", () => {
	it("drops arbitrary classes from raw spans (overlay hijack)", () => {
		const html = render('<span class="fixed inset-0 z-[70] bg-black">covered</span>');
		expect(html).toContain("covered");
		expect(html).not.toContain("fixed");
		expect(html).not.toContain("inset-0");
		expect(html).not.toContain("z-[70]");
	});

	it("keeps fenced code language classes for badge and mermaid routing", () => {
		const html = render("```ts\nconst x = 1\n```");
		expect(html).toContain(">typescript</span>");
		const mermaid = render("```mermaid\ngraph TD\nA-->B\n```");
		expect(parseHTML(mermaid).document.documentElement.textContent).toContain("graph TD");
	});

	it("strips non-language tokens from raw code class lists", () => {
		const html = render('<code class="language-js fixed">x()</code>');
		expect(html).not.toContain("fixed");
	});

	it("still renders raw HTML content after attribute stripping", () => {
		const html = render('<mark class="bg-red-500">kept</mark>');
		expect(html).toContain("kept");
	});
});
