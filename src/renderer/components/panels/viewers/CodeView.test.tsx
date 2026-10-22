import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { CodeView } from "./CodeView";

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

describe("CodeView show all lines", () => {
	it("hands focus to the first line it revealed when the button goes away", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		const code = Array.from({ length: 5003 }, (_, i) => `row ${i + 1}`).join("\n");
		await act(async () =>
			root?.render(
				<I18nProvider>
					<CodeView code={code} language="plaintext" wrap={false} />
				</I18nProvider>,
			),
		);
		const more = Array.from(document.querySelectorAll("button")).at(-1) as HTMLElement;
		await act(async () => more.click());
		expect(document.querySelectorAll("button")).toHaveLength(0);
		expect(focused?.textContent).toContain("row 5001");
		expect(focused?.getAttribute("tabindex")).toBe("-1");
	});
});
