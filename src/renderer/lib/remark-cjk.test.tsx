/**
 * Korean replies: a strong run ending in punctuation stays bold before a glued
 * suffix, and a bare URL stops at glued Korean prose. Cases from Mixdog's own
 * tests (markdown-pipeline.test.mjs, markdown-links.test.mjs).
 */
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n";
import { MarkdownRenderer, preloadMarkdownPipeline } from "./markdown";

beforeAll(() => preloadMarkdownPipeline());

function render(source: string) {
	const html = renderToStaticMarkup(
		<I18nProvider>
			<MarkdownRenderer content={source} />
		</I18nProvider>,
	);
	return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document;
}

describe("strong before a glued suffix", () => {
	it("closes after punctuation", () => {
		const doc = render("**0.118%**이며 **0.2%**tail");
		expect([...doc.querySelectorAll("strong")].map(node => node.textContent)).toEqual(["0.118%", "0.2%"]);
		expect(doc.querySelector("p")?.textContent).toBe("0.118%이며 0.2%tail");
	});

	it("keeps inline code inside and never searches it", () => {
		for (const [source, text, strong, code] of [
			[
				"현재 Chrome은 **디시인사이드 `AI 활용 마이너 갤러리`**를 보고 있습니다.",
				"현재 Chrome은 디시인사이드 AI 활용 마이너 갤러리를 보고 있습니다.",
				["디시인사이드 AI 활용 마이너 갤러리"],
				["AI 활용 마이너 갤러리"],
			],
			["**앞 `코드` 뒤(설명)**입니다.", "앞 코드 뒤(설명)입니다.", ["앞 코드 뒤(설명)"], ["코드"]],
			["**`첫째`와 `둘째`(설명)**입니다.", "첫째와 둘째(설명)입니다.", ["첫째와 둘째(설명)"], ["첫째", "둘째"]],
			["**`첫째`**와 **`둘째`(설명)**입니다.", "첫째와 둘째(설명)입니다.", ["첫째", "둘째(설명)"], ["첫째", "둘째"]],
			["__앞 `코드` 뒤(설명)__입니다.", "앞 코드 뒤(설명)입니다.", ["앞 코드 뒤(설명)"], ["코드"]],
			["`**a%**b` stays code", "**a%**b stays code", [], []],
		] as const) {
			const doc = render(source);
			expect(doc.querySelector("p")?.textContent, source).toBe(text);
			expect(
				[...doc.querySelectorAll("strong")].map(node => node.textContent),
				source,
			).toEqual(strong);
			expect(
				[...doc.querySelectorAll("strong code")].map(node => node.textContent),
				source,
			).toEqual(code);
		}
	});
});

describe("bare URLs before glued Korean", () => {
	it("cut the link at the Korean text", () => {
		for (const [source, href, text] of [
			[
				"페이지(https://aiscroll.io/ko/mixdog/)와 비교",
				"https://aiscroll.io/ko/mixdog/",
				"페이지(https://aiscroll.io/ko/mixdog/)와 비교",
			],
			[
				"주소는 https://example.com/a_(b)입니다",
				"https://example.com/a_(b)",
				"주소는 https://example.com/a_(b)입니다",
			],
			["주소는 https://example.com/docs.에서", "https://example.com/docs", "주소는 https://example.com/docs.에서"],
			["www.example.com/x)를 여세요", "http://www.example.com/x", "www.example.com/x)를 여세요"],
			["https://a.io/x에서", "https://a.io/x", "https://a.io/x에서"],
			["(https://a.io/x)", "https://a.io/x", "(https://a.io/x)"],
			[
				"https://en.wikipedia.org/wiki/Foo_(bar)",
				"https://en.wikipedia.org/wiki/Foo_(bar)",
				"https://en.wikipedia.org/wiki/Foo_(bar)",
			],
		] as const) {
			const doc = render(source);
			const links = doc.querySelectorAll("a");
			expect(links.length, source).toBe(1);
			expect(decodeURI(links[0]?.getAttribute("href") ?? ""), source).toBe(href);
			expect(doc.querySelector("p")?.textContent, source).toBe(text);
		}
	});

	it("leaves explicit links whole", () => {
		for (const [source, href, caption] of [
			["[https://example.com/와](https://example.com/와)", "https://example.com/와", "https://example.com/와"],
			["[label](https://a.io/x)에서", "https://a.io/x", "label"],
		] as const) {
			const link = render(source).querySelector("a");
			expect(decodeURI(link?.getAttribute("href") ?? ""), source).toBe(href);
			expect(link?.textContent, source).toBe(caption);
		}
	});
});
