/**
 * ```svg fences in assistant markdown: a well-formed document renders as a
 * zoomable data: URL image with a Preview/Code switch and nothing executable
 * survives; an invalid or still-streaming fence renders as code.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n";
import { MarkdownRenderer, preloadMarkdownPipeline } from "./markdown";

beforeAll(() => preloadMarkdownPipeline());

function render(content: string): string {
	return renderToStaticMarkup(
		<I18nProvider>
			<MarkdownRenderer content={content} codeLineNumbers={false} />
		</I18nProvider>,
	);
}

const HOSTILE = [
	'<svg viewBox="0 0 20 20" onload="alert(1)">',
	"  <script>alert(2)</script>",
	'  <a href="javascript:alert(3)"><circle cx="10" cy="10" r="8" fill="var(--accent)"/></a>',
	"</svg>",
].join("\n");

/** The decoded SVG documents behind every data: URL image in `html`. */
function svgImages(html: string): string[] {
	return [...html.matchAll(/<img[^>]*src="data:image\/svg\+xml;charset=utf-8,([^"]*)"/g)].map(match =>
		decodeURIComponent((match[1] ?? "").replaceAll("&amp;", "&")),
	);
}

describe("svg fences", () => {
	it("render as a zoomable data URL image with no script surviving", () => {
		const html = render(`Here:\n\n\`\`\`svg\n${HOSTILE}\n\`\`\`\n`);
		const images = svgImages(html);
		expect(images).toHaveLength(1);
		const svg = images[0] ?? "";
		expect(svg).toContain('<circle cx="10" cy="10" r="8" fill="currentColor"/>');
		expect(svg).not.toMatch(/script|onload|javascript|<a\b|alert/i);
		expect(html).toContain("data-svg-preview");
		expect(html).toContain("data-zoomable-image");
		// Preview/Code switch; the source is not on screen in preview mode.
		expect(html).toContain(">Preview<");
		expect(html).toContain(">Code<");
		expect(html).not.toContain("&lt;script&gt;");
		// No inline SVG ever reaches the DOM.
		expect(html).not.toMatch(/<svg[\s>]/);
	});

	it("match the fence language case-insensitively, as stock does", () => {
		expect(svgImages(render('```SVG\n<svg viewBox="0 0 1 1"/>\n```\n'))).toHaveLength(1);
	});

	it("show code while the document is invalid", () => {
		const html = render("```svg\n<svg><g></svg>\n```\n");
		expect(svgImages(html)).toHaveLength(0);
		expect(html).not.toContain("data-svg-preview");
		expect(html).toContain("&lt;svg&gt;&lt;g&gt;&lt;/svg&gt;");
	});

	it("show code while the fence is still streaming", () => {
		const html = render('```svg\n<svg viewBox="0 0 10 10">\n  <rect width="10" hei');
		expect(svgImages(html)).toHaveLength(0);
		expect(html).toContain("&lt;rect width=");
	});

	it("leave other fences alone", () => {
		const html = render("```xml\n<svg/>\n```\n");
		expect(svgImages(html)).toHaveLength(0);
		expect(html).toContain("&lt;svg/&gt;");
	});
});
