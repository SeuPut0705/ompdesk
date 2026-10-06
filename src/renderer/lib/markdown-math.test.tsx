import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n";
import { MarkdownRenderer } from "./markdown";

function render(content: string, singleDollarTextMath = true) {
	return parseHTML(
		renderToStaticMarkup(
			<I18nProvider>
				<MarkdownRenderer content={content} singleDollarTextMath={singleDollarTextMath} />
			</I18nProvider>,
		),
	).document;
}

describe("Markdown math rendering", () => {
	it("typesets the reported bracket equations without turning equals lines into headings", () => {
		const formulas = [
			String.raw`\boxed{TPM = TPS \times 60}`,
			String.raw`W_{\text{bytes}} \approx P\times\frac{b_{\text{effective}}}{8}`,
			String.raw`\boxed{TPS_{\text{decode}}\approx \frac{\text{显存有效带宽，byte/s}}{\text{每步读取的权重，byte}}}`,
			String.raw`TPS_{\text{decode}}
=
\frac{500-1}{12-2}
=
49.9`,
		];
		const document = render(formulas.map(value => `\\[\n${value}\n\\]`).join("\n\n"));
		expect(document.querySelectorAll(".katex-display")).toHaveLength(formulas.length);
		expect(document.querySelectorAll("annotation")).toHaveLength(formulas.length);
		expect(document.querySelector("h1, h2, .katex-error")).toBeNull();
		expect(Array.from(document.querySelectorAll("annotation"), node => node.textContent?.trim())).toEqual(formulas);
	});

	it("renders parenthesized inline math inside list items and preserves its TeX commands", () => {
		const document = render(String.raw`- \(P\)：参数数量，例如 \(8\times10^9\)。
- \(b_{\text{effective}}\)：实际平均每参数位数。`);
		expect(document.querySelectorAll("li .katex")).toHaveLength(3);
		expect(document.querySelector(".katex-display")).toBeNull();
		expect(document.querySelectorAll("annotation")[1].textContent).toBe(String.raw`8\times10^9`);
	});

	it("leaves code, escaped delimiters and ordinary brackets literal", () => {
		const literal = String.raw`\[\frac{1}{2}\]`;
		const document = render(
			[
				`\`${literal}\``,
				`\`\`\`tex\n${literal}\n\`\`\``,
				`    ${literal}`,
				String.raw`\\(x\\) and [x] and (x)`,
			].join("\n\n"),
		);
		expect(document.querySelector(".katex")).toBeNull();
		expect(Array.from(document.querySelectorAll("code"), node => node.textContent)).toEqual([
			literal,
			literal,
			literal,
		]);
	});

	it("retains dollar math and honors the user-message literal-dollar option", () => {
		const document = render("$x^2$\n\n$$\nx = y\n$$");
		expect(document.querySelectorAll(".katex")).toHaveLength(2);
		expect(document.querySelectorAll(".katex-display")).toHaveLength(1);
		const user = render(String.raw`$.first ... $.second and \(x^2\)`, false);
		expect(user.documentElement.textContent).toContain("$.first ... $.second");
		expect(user.querySelectorAll(".katex")).toHaveLength(1);
	});

	it("renders display math in lists and quotes without swallowing following prose", () => {
		const document = render(String.raw`- Equation:

  \[
  x
  =
  \frac{1}{2}
  \]

  Explanation

> \[
> y = 2
> \]

After`);
		expect(document.querySelectorAll("li .katex-display")).toHaveLength(1);
		expect(document.querySelectorAll("blockquote .katex-display")).toHaveLength(1);
		expect(document.querySelector("li")?.textContent).toContain("Explanation");
		expect(document.documentElement.textContent).toContain("After");
		expect(document.querySelector("h1, h2, .katex-error")).toBeNull();
	});

	it("supports same-line display delimiters and CRLF line endings", () => {
		const source = String.raw`\[\boxed{TPM = TPS \times 60}\]

\[
x = y
\]`;
		const document = render(source.replaceAll("\n", "\r\n"));
		expect(document.querySelectorAll(".katex-display")).toHaveLength(2);
		expect(document.querySelector(".katex-error")).toBeNull();
	});

	it("does not consume escaped closing delimiters or hide incomplete equations", () => {
		const source = String.raw`\(a \\) + b\)`;
		expect(render(source).querySelector("annotation")?.textContent).toBe(String.raw`a \\) + b`);
		const unfinished = render(String.raw`\[
\frac{1}{2}

Still readable`);
		expect(unfinished.querySelector(".katex")).toBeNull();
		expect(unfinished.documentElement.textContent).toContain(String.raw`\frac{1}{2}`);
		expect(unfinished.documentElement.textContent).toContain("Still readable");
	});

	it("keeps untrusted TeX links and HTML inert while rendering adjacent valid math", () => {
		const document = render(String.raw`\(\href{javascript:alert(1)}{click}\)

\[\htmlClass{fixed}{x}\]

<span class="fixed" onclick="alert(1)">text</span>

\[x^2\]`);
		expect(document.querySelector('[href^="javascript:"], [onclick], .fixed')).toBeNull();
		expect(document.querySelectorAll("annotation")).toHaveLength(3);
		expect(document.querySelectorAll("annotation")[2].textContent).toBe("x^2");
	});
});
