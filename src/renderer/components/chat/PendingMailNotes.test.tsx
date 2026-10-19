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
const { PendingMailNotes } = await import("./PendingMailNotes");

let container: HTMLElement;
let root: Root;

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useSessionStore.getState().reset();
});

describe("PendingMailNotes", () => {
	it("shows each report the bridge holds as a waiting line, and nothing once they landed", async () => {
		useSessionStore.setState({
			pendingMail: [
				{ id: "p1", from: "Part A", kind: "progress" },
				{ id: "n1", from: "Part B", kind: "note" },
			],
		});
		container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		await act(async () => {
			root.render(
				<I18nProvider>
					<PendingMailNotes />
				</I18nProvider>,
			);
		});
		const lines = [...container.querySelectorAll("[data-agent-mail-pending]")].map(line => line.textContent);
		expect(lines).toEqual([
			"⑂ Session report · Part A·progress·shows when this turn ends",
			"⑂ Session report · Part B·note·shows when this turn ends",
		]);
		// Not a button: nothing to open until the report itself arrives.
		expect(container.querySelector("button")).toBeNull();

		await act(async () => useSessionStore.setState({ pendingMail: [] }));
		expect(container.querySelector("[data-agent-mail-pending]")).toBeNull();
	});
});
