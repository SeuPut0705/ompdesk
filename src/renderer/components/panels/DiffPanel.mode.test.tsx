/** The Changes panel keeps its source (Repository, History, Edit results…) while another view or a narrower window remounts it. */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { DiffPanel } from "./DiffPanel";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<DiffPanel />
			</I18nProvider>,
		);
	});
}

async function unmount(): Promise<void> {
	await act(async () => {
		root.unmount();
	});
	container.remove();
}

const source = () => document.querySelector('select[aria-label="Changes"]') as unknown as HTMLSelectElement;

afterEach(async () => {
	useUiStore.setState({ changesMode: "repository" });
	useToolsStore.getState().reset();
	useMessagesStore.getState().reset();
});

describe("DiffPanel source", () => {
	it("comes back on the source the user picked after the panel unmounted", async () => {
		await mount();
		expect(source().value).toBe("repository");
		await act(async () => {
			Object.defineProperty(source(), "value", { configurable: true, value: "timeline" });
			source().dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(useUiStore.getState().changesMode).toBe("timeline");
		await unmount();

		await mount();
		expect(source().value).toBe("timeline");
		await unmount();
	});
});
