import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { DiagnosticsList } from "./Diagnostics";

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

describe("DiagnosticsList", () => {
	it("hands focus to the first diagnostic its '+N more' revealed, inside the file group it lands in", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		const files = [
			{ path: "a.ts", errored: true, messages: ["raw a1", "raw a2", "raw a3", "raw a4"] },
			{ path: "b.ts", errored: true, messages: ["raw b1", "raw b2", "raw b3"] },
		];
		await act(async () =>
			root?.render(
				<I18nProvider>
					<DiagnosticsList files={files} />
				</I18nProvider>,
			),
		);
		const more = Array.from(document.querySelectorAll("button")).at(-1) as HTMLElement;
		await act(async () => more.click());
		expect(focused?.textContent).toContain("b2");
		expect(focused?.getAttribute("tabindex")).toBe("-1");
	});
});
