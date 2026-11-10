/** IconButton: a disabled icon that says why stays focusable, refuses its press and shows its name and the reason. */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { IconButton } from "./IconButton";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

it("keeps a disabled icon that says why focusable, refuses its press and shows its name and reason on focus", async () => {
	const click = vi.fn();
	// linkedom knows no `:focus-visible`; this focus came from the keyboard.
	const matches = HTMLElement.prototype.matches;
	vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
		return selector === ":focus-visible" || matches.call(this, selector);
	});
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () =>
		root?.render(
			<IconButton
				disabled
				disabledReason="The agent can use web pages, not visuals"
				icon={<svg />}
				label="Let the agent use this page"
				onClick={click}
				onKeyDown={click}
				onPointerDown={click}
			/>,
		),
	);
	const button = document.querySelector("button") as unknown as HTMLButtonElement;
	expect(button.disabled).toBe(false);
	expect(button.getAttribute("aria-disabled")).toBe("true");
	expect(button.getAttribute("aria-label")).toBe("Let the agent use this page");
	await act(async () => button.click());
	await act(async () => button.dispatchEvent(new Event("pointerdown", { bubbles: true })));
	const enter = new Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperty(enter, "key", { value: "Enter" });
	await act(async () => button.dispatchEvent(enter));
	expect(click).not.toHaveBeenCalled();
	await act(async () => button.dispatchEvent(new Event("focusin", { bubbles: true })));
	const bubble = document.querySelector("[role=tooltip]");
	expect(bubble?.textContent).toBe("Let the agent use this pageThe agent can use web pages, not visuals");
	expect(button.getAttribute("aria-describedby")).toBe(bubble?.id);
});
