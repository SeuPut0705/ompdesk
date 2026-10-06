/**
 * Contract tests for markdown code line numbers (plan B3): the
 * `codeLineNumbers` GUI pref gates a line-number gutter on markdown-rendered
 * code blocks. Fences render through the same shared CodeBlock as the tool
 * cards (badge, copy, gutter) — the pref just threads into its
 * `showLineNumbers`. SSR drives the pref via the MarkdownRenderer
 * `codeLineNumbers` prop — the pref store's server snapshot is off, and
 * subscriptions never run under renderToStaticMarkup.
 */
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n";
import { MarkdownRenderer } from "./markdown";

function render(content: string, codeLineNumbers?: boolean): string {
	return renderToStaticMarkup(
		<I18nProvider>
			<MarkdownRenderer content={content} codeLineNumbers={codeLineNumbers} />
		</I18nProvider>,
	);
}

const FENCE = "```ts\nalpha\nbeta\ngamma\n```";
/** The gutter renders as one preformatted text node, one number per line. */
const GUTTER_ROWS = ">1\n2\n3</div>";
/** Metrics class combo of the shared CodeBlock gutter. */
const SHARED_GUTTER = "px-2.5 py-3 text-omp-md leading-[1.5]";

describe("markdown code line numbers", () => {
	it("renders the gutter beside block code when the pref is on", () => {
		const html = render(FENCE, true);
		expect(html).toContain(GUTTER_ROWS);
		expect(html).toContain(SHARED_GUTTER);
		// The code itself still renders, still inside a <pre>.
		expect(html).toContain("alpha");
		expect(html).toContain("<pre");
	});

	it("omits the gutter when the pref is off", () => {
		const html = render(FENCE, false);
		expect(html).not.toContain(GUTTER_ROWS);
		expect(html).not.toContain(SHARED_GUTTER);
		expect(html).toContain("alpha");
	});

	it("defaults to off without a prop (pref store server snapshot)", () => {
		const html = render(FENCE);
		expect(html).not.toContain(GUTTER_ROWS);
		expect(html).toContain("alpha");
	});

	it("does not number inline code", () => {
		const html = render("use `npm test` here", true);
		expect(html).not.toContain('aria-hidden="true"');
		expect(html).toContain("npm test");
	});

	it("mermaid fences render as diagrams, not numbered code", () => {
		// MermaidBlock owns the fence; SSR falls back to the shared CodeBlock
		// showing the mermaid source — exactly one gutter, marked as mermaid.
		const html = render("```mermaid\ngraph TD\nA-->B\n```", true);
		expect(parseHTML(html).document.documentElement.textContent).toContain("graph TD");
		expect(html).toContain(">mermaid</span>");
	});

	it("strips the fence's trailing newline when counting lines", () => {
		// textOf yields "alpha\nbeta\ngamma\n" — a fourth gutter row would mean
		// the trailing newline was counted as a visible line.
		const html = render(FENCE, true);
		expect(html).toContain(GUTTER_ROWS);
		expect(html).not.toContain("1\n2\n3\n4");
	});

	it("fences carry the shared chrome: language badge and copy button", () => {
		const html = render(FENCE, false);
		// Language badge (uppercased) and the copy affordance share the header.
		expect(html).toContain(">typescript</span>");
		expect(html).toContain("<button");
	});
});
