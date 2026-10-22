import { parseHTML } from "linkedom";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
// linkedom lays nothing out: a <pre> reports the width its longest line would take, every box 300 × 200.
const LINE_PX = 8;
Object.defineProperties(HTMLElement.prototype, {
	clientWidth: { configurable: true, get: () => 300 },
	clientHeight: { configurable: true, get: () => 200 },
	scrollWidth: {
		configurable: true,
		get(this: HTMLElement) {
			if (this.tagName !== "PRE") return 300;
			return Math.max(300, ...(this.textContent ?? "").split("\n").map(line => line.length * LINE_PX));
		},
	},
	scrollHeight: { configurable: true, get: () => 200 },
});

// The live observers and what each watches, so a test can tell which <pre> is measured on a resize.
const observed = new Set<Element>();
(globalThis as Record<string, unknown>).ResizeObserver = class {
	#mine: Element[] = [];
	observe(element: Element) {
		this.#mine.push(element);
		observed.add(element);
	}
	disconnect() {
		for (const element of this.#mine) observed.delete(element);
	}
};

const { createRoot } = await import("react-dom/client");
const { CodeBlock } = await import("./CodeBlock");

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

async function mount(code: string, showLineNumbers = true): Promise<void> {
	if (!root) {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	}
	await act(async () =>
		root?.render(
			<I18nProvider>
				<CodeBlock code={code} language="plaintext" showLineNumbers={showLineNumbers} />
			</I18nProvider>,
		),
	);
}

describe("CodeBlock keyboard scrolling", () => {
	it("gives a block whose code runs past its width a tab stop, and a block that fits none", async () => {
		await mount(`const wide = "${"x".repeat(80)}";`);
		const pre = document.querySelector("pre");
		expect(pre?.getAttribute("tabindex")).toBe("0");
		expect(pre?.getAttribute("aria-label")).toBe("Code");

		await act(async () => root?.unmount());
		root = undefined;
		document.body.innerHTML = "";
		await mount("const short = 1;");
		expect(document.querySelector("pre")?.hasAttribute("tabindex")).toBe(false);
	});

	it("measures the <pre> that replaced the old one when line numbers are switched", async () => {
		const wide = `const wide = "${"x".repeat(80)}";`;
		await mount(wide, false);
		expect(document.querySelector("pre")?.getAttribute("tabindex")).toBe("0");
		await mount(wide, true);
		const pre = document.querySelector("pre");
		expect(pre?.getAttribute("tabindex")).toBe("0");
		// A later resize is measured on the <pre> now on screen, not the one the switch removed.
		expect(pre && observed.has(pre)).toBe(true);
	});
});
