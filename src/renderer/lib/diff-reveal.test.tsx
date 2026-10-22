import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { DiffView } from "./diff";
import { I18nProvider } from "./i18n";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
// linkedom has no focus model: record what `focus()` reached.
let focused: HTMLElement | null = null;
Object.defineProperty(HTMLElement.prototype, "focus", {
	configurable: true,
	value(this: HTMLElement) {
		focused = this;
	},
});

let root: Root | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.innerHTML = "";
	focused = null;
});

function contextDiff(count: number): string {
	const rows: string[] = ["@@ -1,1 +1,1 @@"];
	for (let i = 1; i <= count; i++) rows.push(` line ${i}`);
	return rows.join("\n");
}

describe("DiffView show more", () => {
	it("hands focus to the first row it revealed when the button goes away", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<I18nProvider>
					<DiffView diff={contextDiff(400)} />
				</I18nProvider>,
			),
		);
		const more = Array.from(document.querySelectorAll("button")).find(button =>
			button.textContent?.includes("more lines"),
		) as HTMLElement;
		await act(async () => more.click());
		expect(Array.from(document.querySelectorAll("button")).some(b => b.textContent?.includes("more lines"))).toBe(
			false,
		);
		expect(focused?.textContent).toContain("line 151");
		expect(focused?.getAttribute("tabindex")).toBe("-1");
	});
});
