import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { CappedRows } from "./board-parts";

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
let focused: unknown = null;
Object.defineProperty(HTMLElement.prototype, "focus", {
	configurable: true,
	value(this: unknown) {
		focused = this;
	},
});
Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused });

let root: Root | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.innerHTML = "";
});

describe("CappedRows", () => {
	it("puts focus on the first row its '+N more' reveals, not back on the page", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		const items = ["a", "b", "c", "d", "e"];
		await act(async () =>
			root?.render(
				<I18nProvider language="en">
					<ul>
						<li>
							<button type="button">before</button>
						</li>
						<CappedRows cap={2} items={items}>
							{item => (
								<li key={item}>
									<button type="button">{`row ${item}`}</button>
								</li>
							)}
						</CappedRows>
					</ul>
				</I18nProvider>,
			),
		);
		const more = document.querySelector("[data-board-more]") as HTMLElement;
		expect(more.getAttribute("data-board-more")).toBe("3");
		more.focus();
		await act(async () => more.click());
		expect(document.querySelector("[data-board-more]")).toBeNull();
		expect(document.activeElement?.textContent).toBe("row c");
	});
});
