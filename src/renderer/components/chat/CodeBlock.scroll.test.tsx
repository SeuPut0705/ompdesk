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

const { createRoot } = await import("react-dom/client");
const { CodeBlock } = await import("./CodeBlock");

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.innerHTML = "";
});

async function mount(code: string): Promise<void> {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<CodeBlock code={code} language="plaintext" />
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
		document.body.innerHTML = "";
		await mount("const short = 1;");
		expect(document.querySelector("pre")?.hasAttribute("tabindex")).toBe(false);
	});
});
