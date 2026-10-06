import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { TurnStatusRow } = await import("./ChatStream");

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<TurnStatusRow />
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useSessionStore.getState().reset();
});

describe("TurnStatusRow", () => {
	it("announces a stable waiting state without repeating the elapsed clock", async () => {
		useSessionStore.setState({ awaitingModelSince: Date.now() - 5_000 });
		await mount();

		const status = container.querySelector('[role="status"]');
		expect(status?.textContent).toBe("Waiting for model response…");
		expect(container.textContent).toMatch(/Waiting for model response… \d+s/);
		expect(container.querySelectorAll(".animate-spin")).toHaveLength(1);
	});
});
