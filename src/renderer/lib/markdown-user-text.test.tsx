import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n";
import { MarkdownRenderer, preloadMarkdownPipeline } from "./markdown";

beforeAll(() => preloadMarkdownPipeline());

function render(content: string, userText: boolean) {
	return parseHTML(
		renderToStaticMarkup(
			<I18nProvider>
				<MarkdownRenderer content={content} userText={userText} />
			</I18nProvider>,
		),
	).document;
}

describe("a person's own text", () => {
	it("keeps each line break typed with Shift+Enter, outside code too", () => {
		const typed = render("첫 줄\n둘째 줄\n- 항목\n\n**굵게**\n다음 줄\n\n```\na\nb\n```", true);
		const paragraphs = [...typed.querySelectorAll("p")].map(p => ({ innerHTML: p.innerHTML.replaceAll("\n", "") }));
		expect(paragraphs[0]?.innerHTML).toBe("첫 줄<br>둘째 줄");
		expect(paragraphs[1]?.innerHTML).toBe("<strong>굵게</strong><br>다음 줄");
		expect(typed.querySelector("li")?.textContent).toBe("항목");
		// A fenced block keeps its own lines and gets no <br>.
		expect(typed.querySelector("pre")?.querySelector("br")).toBeNull();
		expect(typed.querySelector("pre")?.textContent).toContain("a\nb");
	});

	it("leaves a model's reply as Markdown reads it: a single newline is a space", () => {
		const reply = render("first line\nsame paragraph", false);
		expect(reply.querySelector("p br")).toBeNull();
	});
});
