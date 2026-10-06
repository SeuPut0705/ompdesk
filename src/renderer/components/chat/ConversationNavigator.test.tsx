import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { ConversationNavigator } from "./ConversationNavigator";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

async function mount(onNavigate: (rowIndex: number) => void): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ConversationNavigator
					activeIndex={1}
					anchors={[
						{ key: "one", rowIndex: 3, preview: "First question", timestamp: 100 },
						{ key: "two", rowIndex: 9, preview: "Second question", timestamp: 200 },
						{ key: "three", rowIndex: 14, preview: "Third question", timestamp: 300 },
					]}
					onNavigate={onNavigate}
				/>
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	if (root) await act(async () => root.unmount());
	container?.remove();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("ConversationNavigator", () => {
	it("marks the current turn and jumps to the selected virtual row", async () => {
		const onNavigate = vi.fn();
		await mount(onNavigate);
		const buttons = Array.from(container.querySelectorAll("button"));

		expect(buttons).toHaveLength(3);
		expect(container.querySelector(".omp-conversation-nav-stack")).not.toBeNull();
		expect(buttons.every(button => !button.hasAttribute("style"))).toBe(true);
		expect(buttons[1]?.getAttribute("aria-current")).toBe("location");
		await act(async () => buttons[2]?.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
		expect(onNavigate).toHaveBeenCalledWith(14);
	});

	it("shows the user-message preview on hover", async () => {
		await mount(() => {});
		const first = container.querySelector("button");
		await act(async () => first?.dispatchEvent(new Event("mouseover", { bubbles: true })));

		expect(container.querySelector("[role='tooltip']")?.textContent ?? "").toContain("First question");
	});
});
