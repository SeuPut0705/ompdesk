/**
 * GitHub-flavored structure in assistant markdown: footnotes whose refs and
 * backrefs reach their (prefixed) targets, task lists, table alignment,
 * alerts, heading anchors and in-document links, plain unlabeled fences,
 * mermaid source view, code wrap, streaming-safe fences, and the link
 * schemes the transcript opens (local://, mailto:).
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../stores/ui";
import { loadHljs } from "./highlight";
import { I18nProvider } from "./i18n";
import { MarkdownRenderer, preloadMarkdownPipeline } from "./markdown";

beforeAll(async () => {
	await preloadMarkdownPipeline();
	await loadHljs();
});

function html(content: string, streaming?: boolean): string {
	return renderToStaticMarkup(
		<I18nProvider>
			<MarkdownRenderer content={content} streaming={streaming} />
		</I18nProvider>,
	);
}

function doc(content: string, streaming?: boolean): Document {
	return parseHTML(`<html><body>${html(content, streaming)}</body></html>`).document as unknown as Document;
}

describe("footnotes", () => {
	it("keeps prefixed ids so refs and backrefs point at each other", () => {
		const page = doc("Claim[^src].\n\n[^src]: The source.");
		const ref = page.querySelector("sup a");
		expect(ref?.getAttribute("href")).toBe("#fn-src");
		expect(ref?.getAttribute("id")).toBe("user-content-fnref-src");
		expect(ref?.hasAttribute("data-footnote-ref")).toBe(true);
		const note = page.querySelector("section[data-footnotes] li");
		expect(note?.getAttribute("id")).toBe("user-content-fn-src");
		const back = note?.querySelector("a[data-footnote-backref]");
		expect(back?.getAttribute("href")).toBe("#fnref-src");
		expect(back?.getAttribute("aria-label")).toBeTruthy();
	});

	it("prefixes ids raw HTML brings, so nothing can shadow an app element", () => {
		const page = doc('<h2 id="omp">Title</h2>\n\n<a id="root" href="#x">x</a>');
		expect(page.querySelector("h2")?.getAttribute("id")).toBe("user-content-omp");
		expect(page.querySelector("a")?.getAttribute("id")).toBe("user-content-root");
	});
});

describe("task lists", () => {
	it("marks the list and its items so the bullet gives way to the checkbox", () => {
		const page = doc("- [x] done\n- [ ] next");
		expect(page.querySelector("ul")?.getAttribute("class")).toContain("contains-task-list");
		const items = page.querySelectorAll("li");
		expect(items).toHaveLength(2);
		for (const item of items) expect(item.getAttribute("class")).toContain("task-list-item");
	});

	it("keeps raw HTML from claiming any other class on lists", () => {
		const page = doc('<ul class="fixed inset-0"><li class="task-list-item absolute">x</li></ul>');
		expect(page.querySelector("ul")?.getAttribute("class") ?? "").not.toContain("fixed");
		expect(page.querySelector("li")?.getAttribute("class") ?? "").not.toContain("absolute");
	});
});

describe("tables", () => {
	it("aligns header and body cells as the delimiter row says", () => {
		const page = doc("| Name | Count | Note |\n|:-----|:-----:|-----:|\n| a | 1 | x |");
		const [left, center, right] = Array.from(page.querySelectorAll("th"));
		expect(left?.getAttribute("style") ?? "").toContain("text-align:left");
		expect(center?.getAttribute("style") ?? "").toContain("text-align:center");
		expect(right?.getAttribute("style") ?? "").toContain("text-align:right");
		expect(page.querySelectorAll("td")[2]?.getAttribute("style") ?? "").toContain("text-align:right");
		expect(center?.textContent).toBe("Count");
	});
});

describe("GitHub alerts", () => {
	it("renders the marker as a labeled alert and drops it from the body", () => {
		const page = doc("> [!WARNING]\n> Back up first.");
		const alert = page.querySelector("blockquote[data-alert='warning']");
		expect(alert).not.toBeNull();
		expect(alert?.querySelector("[data-alert-title]")?.textContent).toBe("Warning");
		expect(alert?.textContent).toContain("Back up first.");
		expect(alert?.textContent).not.toContain("[!WARNING]");
	});

	it("knows all five kinds, case-insensitively", () => {
		for (const kind of ["note", "tip", "important", "warning", "caution"]) {
			const page = doc(`> [!${kind}]\n> body`);
			expect(page.querySelector("blockquote")?.getAttribute("data-alert")).toBe(kind);
		}
	});

	it("leaves a marker that shares its line, and raw HTML attributes, as a plain quote", () => {
		expect(doc("> [!NOTE] inline\n> body").querySelector("blockquote")?.hasAttribute("data-alert")).toBe(false);
		const raw = doc('<blockquote data-alert="caution">raw</blockquote>');
		expect(raw.querySelector("blockquote")?.hasAttribute("data-alert")).toBe(false);
	});

	it("never sets quotes in italics", () => {
		expect(doc("> quoted").querySelector("blockquote")?.getAttribute("class") ?? "").not.toContain("italic");
	});
});

describe("heading anchors", () => {
	it("gives headings GitHub's ids, numbering repeats", () => {
		const page = doc("# Getting Started!\n\n## Getting Started\n\n### 설치 방법");
		const ids = Array.from(page.querySelectorAll("h1, h2, h3")).map(heading => heading.getAttribute("id"));
		expect(ids).toEqual(["user-content-getting-started", "user-content-getting-started-1", "user-content-설치-방법"]);
	});
});

describe("code fences", () => {
	it("leaves an unlabeled fence plain instead of guessing a language", () => {
		const page = doc("```\nconst x = 1;\nfunction f() { return x; }\n```");
		expect(page.querySelector("pre code")?.querySelector("[class^='hljs-']")).toBeNull();
		expect(page.body.textContent).toContain("Plain text");
		const labeled = doc("```ts\nconst x = 1;\n```");
		expect(labeled.querySelector("pre code")?.querySelector("[class^='hljs-']")).not.toBeNull();
	});

	it("offers a wrap toggle on markdown fences", () => {
		expect(doc("```ts\nconst x = 1;\n```").querySelector("[data-code-wrap]")).not.toBeNull();
	});

	it("keeps a streaming fence plain: no highlight, no diagram", () => {
		const page = doc("```ts\nconst x = 1;\n```\n\n```mermaid\ngraph TD\nA-->B\n```", true);
		expect(page.querySelector("pre code")?.querySelector("[class^='hljs-']")).toBeNull();
		expect(page.querySelector("[data-figure-mode]")).toBeNull();
		expect(page.body.textContent).toContain("graph TD");
	});
});

// ── Interactive (linkedom DOM) ─────────────────────────────────────────────

const dom = parseHTML('<html data-theme="dark"><body></body></html>');
let container: HTMLElement | undefined;
let root: Root | undefined;

async function mount(element: ReactElement): Promise<HTMLElement> {
	const globals = globalThis as Record<string, unknown>;
	Object.assign(globals, {
		document: dom.document,
		window: dom.window,
		Event: dom.Event,
		HTMLElement: dom.HTMLElement,
		Element: dom.Element,
		Node: dom.Node,
		MutationObserver: dom.MutationObserver,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	container = dom.document.createElement("div") as unknown as HTMLElement;
	dom.document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () => root?.render(<I18nProvider>{element}</I18nProvider>));
	return container;
}

async function click(element: Element | null | undefined): Promise<void> {
	if (!element) throw new Error("nothing to click");
	await act(async () => {
		element.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }) as unknown as Event);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
	useUiStore.setState({ filePreviewPath: null });
	Reflect.deleteProperty(dom.window, "omp");
});

function stubScroll(): Element[] {
	const scrolled: Element[] = [];
	const proto = dom.Element.prototype as unknown as { scrollIntoView?: () => void; focus?: () => void };
	proto.scrollIntoView = function (this: Element) {
		scrolled.push(this);
	};
	proto.focus ??= () => {};
	return scrolled;
}

describe("in-document links", () => {
	it("scrolls a footnote ref to its note and the backref back", async () => {
		const scrolled = stubScroll();
		const view = await mount(<MarkdownRenderer content={"Claim[^1].\n\n[^1]: The source."} />);
		await click(view.querySelector("a[data-footnote-ref]"));
		expect(scrolled.at(-1)?.getAttribute("id")).toBe("user-content-fn-1");
		await click(view.querySelector("a[data-footnote-backref]"));
		expect(scrolled.at(-1)?.getAttribute("id")).toBe("user-content-fnref-1");
	});

	it("scrolls a #heading link to the heading in the same message", async () => {
		const scrolled = stubScroll();
		const view = await mount(<MarkdownRenderer content={"See [setup](#setup-steps).\n\n## Setup steps\n\nDo it."} />);
		await click(view.querySelector('a[href="#setup-steps"]'));
		expect(scrolled.at(-1)?.tagName.toLowerCase()).toBe("h2");
	});
});

describe("link schemes", () => {
	it("opens a local:// link as the session file stock resolves", async () => {
		const resolveLocalUrl = vi.fn(async () => ({ success: true, data: { path: "/s/local/PLAN.md" } }));
		Object.assign(dom.window, { omp: { rpc: { resolveLocalUrl }, system: { openExternal: vi.fn() } } });
		const view = await mount(<MarkdownRenderer content="Read [the plan](local://PLAN.md)." />);
		const link = view.querySelector("a");
		expect(link?.getAttribute("href")).toBe("local://PLAN.md");
		await click(link);
		expect(resolveLocalUrl).toHaveBeenCalledWith("local://PLAN.md");
		expect(useUiStore.getState().filePreviewPath).toBe("/s/local/PLAN.md");
	});

	it("hands a mailto: link to the system", async () => {
		const openExternal = vi.fn();
		Object.assign(dom.window, { omp: { system: { openExternal } } });
		const view = await mount(<MarkdownRenderer content="Write to [dev](mailto:dev@example.com)." />);
		await click(view.querySelector("a"));
		expect(openExternal).toHaveBeenCalledWith("mailto:dev@example.com");
	});
});

describe("mermaid and wrap controls", () => {
	it("shows a mermaid fence's source on request", async () => {
		const view = await mount(<MarkdownRenderer content={"```mermaid\ngraph TD\n  A --> B\n```"} />);
		// The figure is a lazy chunk; a slow runner shows its fallback first.
		await act(async () => {
			await vi.waitFor(() => expect(view.querySelector('[data-figure-mode-button="code"]')).not.toBeNull(), {
				timeout: 20_000,
			});
		});
		const code = view.querySelector('[data-figure-mode-button="code"]');
		await click(code);
		expect(view.querySelector(".omp-code-block")?.textContent).toContain("A --> B");
	});

	it("wraps long lines and steps the gutter aside", async () => {
		const view = await mount(<MarkdownRenderer codeLineNumbers content={"```ts\nconst x = 1;\n```"} />);
		expect(view.querySelector("pre[data-code-wrapped]")).toBeNull();
		await click(view.querySelector("[data-code-wrap]"));
		expect(view.querySelector("[data-code-wrap]")?.getAttribute("aria-pressed")).toBe("true");
		expect(view.querySelector("pre[data-code-wrapped]")).not.toBeNull();
		expect(view.querySelector('div[aria-hidden="true"]')).toBeNull();
	});
});
